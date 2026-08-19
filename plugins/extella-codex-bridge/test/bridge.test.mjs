import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { scrubCredentialEnvironment } from "../scripts/bridge-entry.mjs";
import { createBridgeServer, signRequest } from "../scripts/bridge-core.mjs";
import {
  RUNTIME_SCRIPT_FILES,
  deriveAccountBinding,
  existingConfiguredPort,
  writeRuntime,
} from "../scripts/configure-bridge-macos.mjs";
import {
  RULE_MARKER,
  RULE_TEXT,
  accountScopeFromAgentList,
  expertCode,
} from "../scripts/deploy-extella-assets.mjs";
import {
  ProviderAdapterError,
  codexArguments,
  codexResumeArguments,
  invokeProvider,
  runPreflightWithRetry,
  safeProviderDiagnostic,
} from "../scripts/invoke-provider.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const SECRET = "test-secret-with-at-least-thirty-two-bytes";
const BINDING = "a".repeat(64);

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    }),
  );
  return nested.flat();
}

function body(overrides = {}) {
  return {
    schema_version: "1.1",
    event_id: `evt_${randomUUID().replaceAll("-", "")}`,
    account_binding: BINDING,
    capability: "general-assistance",
    provider: "mock",
    prompt: "Synthetic test; do not call a model.",
    budget: { max_output_tokens: 200, timeout_ms: 5000 },
    ...overrides,
  };
}

async function startBridge() {
  const server = createBridgeServer({
    secret: SECRET,
    allowedAccountBindings: [BINDING],
    allowedCapabilities: ["general-assistance"],
    allowedProviders: ["mock"],
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    server,
    url: `http://127.0.0.1:${port}/v1/delegate`,
    healthUrl: `http://127.0.0.1:${port}/health`,
  };
}

async function signedPost(url, payload) {
  const rawBody = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID().replaceAll("-", "");
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Extella-Timestamp": timestamp,
      "X-Extella-Nonce": nonce,
      "X-Extella-Signature": signRequest({
        secret: SECRET,
        timestamp,
        nonce,
        rawBody,
      }),
    },
    body: rawBody,
  });
}

test("signed account-wide mock delegation succeeds", async (t) => {
  const { server, url } = await startBridge();
  t.after(() => server.close());
  const response = await signedPost(url, body());
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "completed");
  assert.equal(result.cost_guard, "no_model_called");
  assert.deepEqual(result.execution_profile, {
    id: "answer-only",
    policy_version: "1.0",
  });
});

test("schema 1.3 accepts the available answer-only profile", async (t) => {
  const { server, url } = await startBridge();
  t.after(() => server.close());
  const response = await signedPost(
    url,
    body({
      schema_version: "1.3",
      execution_profile_id: "answer-only",
    }),
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.execution_profile.id, "answer-only");
});

test("planned and unknown execution profiles fail closed", async (t) => {
  const { server, url } = await startBridge();
  t.after(() => server.close());

  const planned = await signedPost(
    url,
    body({
      schema_version: "1.3",
      execution_profile_id: "workspace-read",
    }),
  );
  assert.equal(planned.status, 400);
  assert.equal(
    (await planned.json()).error.code,
    "execution_profile_unavailable",
  );

  const unknown = await signedPost(
    url,
    body({
      schema_version: "1.3",
      execution_profile_id: "unreviewed-profile",
    }),
  );
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error.code, "execution_profile_unknown");
});

test("raw execution flags cannot cross the bridge contract", async (t) => {
  const { server, url } = await startBridge();
  t.after(() => server.close());
  const response = await signedPost(
    url,
    body({
      schema_version: "1.3",
      execution_profile_id: "answer-only",
      tools_disabled: false,
    }),
  );
  assert.equal(response.status, 400);
  const result = await response.json();
  assert.equal(result.error.code, "invalid_request");
  assert.match(result.error.message, /tools_disabled is not allowed/);
});

test("health publishes the reviewed execution-profile catalog", async (t) => {
  const { server, healthUrl } = await startBridge();
  t.after(() => server.close());
  const response = await fetch(healthUrl);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.execution_policy_version, "1.0");
  assert.equal(result.default_execution_profile_id, "answer-only");
  assert.deepEqual(
    result.execution_profiles.map(({ id, status }) => ({ id, status })),
    [
      { id: "answer-only", status: "available" },
      { id: "workspace-read", status: "planned" },
      { id: "web-research", status: "planned" },
    ],
  );
});

test("another Extella account binding is rejected", async (t) => {
  const { server, url } = await startBridge();
  t.after(() => server.close());
  const response = await signedPost(url, body({ account_binding: "b".repeat(64) }));
  assert.equal(response.status, 403);
});

test("bridge updates preserve the port from the existing LaunchAgent", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "extella-port-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plistPath = join(directory, "bridge.plist");
  await writeFile(
    plistPath,
    "<key>EXTELLA_BRIDGE_PORT</key>\n<string>18787</string>\n",
    "utf8",
  );
  assert.equal(await existingConfiguredPort(plistPath), 18787);
});

test("installed runtime includes every local module dependency", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "extella-runtime-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimeDir = join(directory, "runtime");
  await writeRuntime(runtimeDir);

  const bundled = new Set(RUNTIME_SCRIPT_FILES);
  for (const filename of bundled) {
    const source = await readFile(join(ROOT, "scripts", filename), "utf8");
    assert.equal(
      await readFile(join(runtimeDir, "scripts", filename), "utf8"),
      source,
      filename,
    );
    const localImports = source.matchAll(
      /(?:from\s+|import\()\s*["']\.\/([^"']+)["']/g,
    );
    for (const match of localImports) {
      assert.ok(
        bundled.has(match[1]),
        `${filename} imports ${match[1]}, which is absent from the runtime bundle`,
      );
    }
  }
  assert.ok(bundled.has("execution-profiles.mjs"));
});

test("account-wide schema 1.2 accepts a bounded conversation ID", async (t) => {
  const { server, url } = await startBridge();
  t.after(() => server.close());
  const response = await signedPost(
    url,
    body({
      schema_version: "1.2",
      conversation_id: `ctx_${"a".repeat(32)}`,
    }),
  );
  assert.equal(response.status, 200);
});

test("account-wide schema 1.2 rejects an unsafe conversation ID", async (t) => {
  const { server, url } = await startBridge();
  t.after(() => server.close());
  const response = await signedPost(
    url,
    body({
      schema_version: "1.2",
      conversation_id: "../../another-chat",
    }),
  );
  assert.equal(response.status, 400);
});

test("account binding is deterministic but does not contain the token", () => {
  const token = "example-extella-token-that-must-not-leak";
  const first = deriveAccountBinding(SECRET, token);
  const second = deriveAccountBinding(SECRET, token);
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(first, /example-extella-token/);
});

test("bridge entry scrubs credential-like environment variables", () => {
  const environment = {
    PATH: "/usr/bin",
    EXTELLA_API_TOKEN: "secret",
    OPENAI_API_KEY: "secret",
    ANTHROPIC_API_KEY: "secret",
  };
  const removed = scrubCredentialEnvironment(environment);
  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.EXTELLA_API_TOKEN, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.ANTHROPIC_API_KEY, undefined);
  assert.deepEqual(removed, [
    "ANTHROPIC_API_KEY",
    "EXTELLA_API_TOKEN",
    "OPENAI_API_KEY",
  ]);
});

test("Codex invocation disables tools, apps, multi-agent, shell, and web", () => {
  const args = codexArguments("/private/tmp/extella-bridge-test");
  const serialized = args.join(" ");
  for (const setting of [
    "features.apps=false",
    "features.multi_agent=false",
    "features.shell_tool=false",
    "tools.web_search=false",
    'web_search="disabled"',
  ]) {
    assert.match(serialized, new RegExp(setting.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.equal(args.includes("--ephemeral"), false);
  assert.match(serialized, /history\.persistence="save-all"/);
});

test("Codex resume targets one persisted thread without ephemeral mode", () => {
  const threadId = "77777777-7777-4777-8777-777777777777";
  const args = codexResumeArguments(threadId);
  assert.deepEqual(args.slice(0, 2), ["exec", "resume"]);
  assert.equal(args.includes(threadId), true);
  assert.equal(args.includes("--ephemeral"), false);
  assert.match(args.join(" "), /sandbox_mode="read-only"/);
});

test("preflight retry is bounded and stops after success", async () => {
  let attempts = 0;
  const result = await runPreflightWithRetry(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("transient preflight failure");
    return "ready";
  }, 1);
  assert.equal(result, "ready");
  assert.equal(attempts, 2);
});

test("preflight retry never exceeds its reviewed budget", async () => {
  let attempts = 0;
  await assert.rejects(
    runPreflightWithRetry(async () => {
      attempts += 1;
      throw new Error("still unavailable");
    }, 1),
    /still unavailable/,
  );
  assert.equal(attempts, 2);
});

test("live bridge creates and resumes an isolated Codex conversation", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "extella-codex-context-"));
  const argsLog = join(temporary, "codex-args.jsonl");
  const previous = {
    CODEX_BIN: process.env.CODEX_BIN,
    EXTELLA_AGENT_BUILDER_LIVE: process.env.EXTELLA_AGENT_BUILDER_LIVE,
    FAKE_CODEX_ARGS_LOG: process.env.FAKE_CODEX_ARGS_LOG,
  };
  process.env.CODEX_BIN = join(ROOT, "test", "fixtures", "bin", "fake-codex");
  process.env.EXTELLA_AGENT_BUILDER_LIVE = "I_UNDERSTAND_COST";
  process.env.FAKE_CODEX_ARGS_LOG = argsLog;
  t.after(async () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(temporary, { recursive: true, force: true });
  });

  const first = await invokeProvider({
    provider: "codex",
    live: true,
    accountBinding: BINDING,
    eventId: "evt_context_first",
    prompt: "Remember the first turn.",
    workspace: temporary,
    stateDir: join(temporary, "state"),
  });
  assert.match(first.conversation_id, /^ctx_[A-Za-z0-9_-]{32,64}$/);
  assert.doesNotMatch(JSON.stringify(first), /77777777-7777-4777-8777-777777777777/);

  const second = await invokeProvider({
    provider: "codex",
    live: true,
    accountBinding: BINDING,
    conversationId: first.conversation_id,
    eventId: "evt_context_second",
    prompt: "Continue the same conversation.",
    workspace: temporary,
    stateDir: join(temporary, "state"),
  });
  assert.equal(second.conversation_id, first.conversation_id);

  await assert.rejects(
    invokeProvider({
      provider: "codex",
      live: true,
      accountBinding: BINDING,
      conversationId: first.conversation_id,
      executionProfileId: "workspace-read",
      eventId: "evt_context_other_profile",
      prompt: "A planned profile must fail closed.",
      workspace: temporary,
      stateDir: join(temporary, "state"),
    }),
    (error) => error?.code === "execution_profile_unavailable",
  );

  await assert.rejects(
    invokeProvider({
      provider: "codex",
      live: true,
      accountBinding: "b".repeat(64),
      conversationId: first.conversation_id,
      eventId: "evt_context_other_account",
      prompt: "This account must not see the conversation.",
      workspace: temporary,
      stateDir: join(temporary, "state"),
    }),
    (error) => error?.diagnostic?.code === "codex_conversation_not_found",
  );

  const calls = (await readFile(argsLog, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "exec");
  assert.notEqual(calls[0][1], "resume");
  assert.deepEqual(calls[1].slice(0, 2), ["exec", "resume"]);
  assert.equal(
    calls[1].includes("77777777-7777-4777-8777-777777777777"),
    true,
  );
});

test("output-budget failure exposes only safe structured diagnostics", () => {
  const diagnostic = safeProviderDiagnostic(
    new ProviderAdapterError("codex_output_budget_exceeded", "provider_validate", {
      actual_output_tokens: 1165,
      requested_max_output_tokens: 800,
      prompt: "must not appear",
      stderr: "must not appear",
    }),
    "evt_budget_test",
  );
  assert.equal(diagnostic.code, "codex_output_budget_exceeded");
  assert.equal(diagnostic.details.actual_output_tokens, 1165);
  assert.equal(diagnostic.details.requested_max_output_tokens, 800);
  assert.equal("prompt" in diagnostic.details, false);
  assert.equal("stderr" in diagnostic.details, false);
});

test("global Expert is loopback-only and supports reviewed profiles", async () => {
  const expert = await readFile(
    join(ROOT, "experts", "extella_codex_account_bridge_v2.fython"),
    "utf8",
  );
  assert.match(expert, /127\.0\.0\.1/);
  assert.match(expert, /max_output_tokens: int = 2000/);
  assert.match(expert, /max_output_tokens > 2000/);
  assert.match(expert, /conversation_id: str = ""/);
  assert.match(expert, /execution_profile_id: str = "answer-only"/);
  assert.match(expert, /"schema_version": "1\.3"/);
  assert.match(expert, /"execution_profile_id": execution_profile_id/);
  assert.match(expert, /"workspace-read"/);
  assert.match(expert, /"web-research"/);
  assert.match(expert, /urllib\.error\.HTTPError/);
  assert.doesNotMatch(expert, /https?:\/\/(?!127\.0\.0\.1)/);
});

test("global Expert returns strict JSON on every external result path", async () => {
  const expert = await readFile(
    join(ROOT, "experts", "extella_codex_account_bridge_v2.fython"),
    "utf8",
  );
  assert.match(expert, /\) -> str:/);
  assert.match(expert, /def strict_json\(payload\):/);
  assert.match(expert, /return strict_json\(result\)/);
  assert.doesNotMatch(expert, /^\s+return\s+(?:result|\{)/m);
});

test("global Expert prefers active launchd bridge transport settings", async () => {
  const expert = await readFile(
    join(ROOT, "experts", "extella_codex_account_bridge_v2.fython"),
    "utf8",
  );
  assert.match(
    expert,
    /secret = launch_environment\("EXTELLA_BRIDGE_SECRET"\) or os\.environ\.get/,
  );
  assert.match(
    expert,
    /launch_environment\("EXTELLA_BRIDGE_PORT"\) or\s+os\.environ\.get/,
  );
  assert.match(expert, /token = local_environment\("EXTELLA_API_TOKEN"\)/);
});

test("MCP configuration uses environment references and contains no tokens", async () => {
  const source = await readFile(join(ROOT, ".mcp.json"), "utf8");
  const config = JSON.parse(source);
  assert.equal(config.mcpServers.extella_primary.bearer_token_env_var, "EXTELLA_API_TOKEN");
  assert.equal(config.mcpServers.extella_secondary.bearer_token_env_var, "EXTELLA_SECONDARY_API_TOKEN");
  assert.doesNotMatch(source, /Bearer\s+[A-Za-z0-9._-]+/);
});

test("plugin manifest, package, installer, and documented tag share one version", async () => {
  const [pluginManifestSource, packageSource, installerSource, readme] =
    await Promise.all([
      readFile(join(ROOT, ".codex-plugin", "plugin.json"), "utf8"),
      readFile(join(ROOT, "package.json"), "utf8"),
      readFile(
        join(ROOT, "integrations", "extella-desktop", "codex-installer.js"),
        "utf8",
      ),
      readFile(resolve(ROOT, "..", "..", "README.md"), "utf8"),
    ]);
  const pluginVersion = JSON.parse(pluginManifestSource).version;
  const packageVersion = JSON.parse(packageSource).version;
  const installerVersion = installerSource.match(
    /var PLUGIN_VERSION = '([^']+)'/,
  )?.[1];
  const builderVersion = installerSource.match(
    /BUILDER_REF = "v([^"]+)"/,
  )?.[1];
  const documentedVersion = readme.match(
    /extella-codex-bridge --ref v([^\s]+)/,
  )?.[1];

  assert.equal(pluginVersion, packageVersion);
  assert.equal(installerVersion, pluginVersion);
  assert.equal(builderVersion, pluginVersion);
  assert.equal(documentedVersion, pluginVersion);
});

test("desktop installer unwraps both Extella result envelopes", async () => {
  const installer = await readFile(
    join(ROOT, "integrations", "extella-desktop", "codex-installer.js"),
    "utf8",
  );
  const body = installer.match(
    /  function _parseRunResult\(response\) \{([\s\S]*?)\n  \}\n\n  function connectionStatus/,
  )?.[1];
  assert.ok(body, "_parseRunResult must remain extractable for contract testing");
  const parse = Function(`return function (response) {${body}\n}`)();
  const value = parse({
    result: {
      result: JSON.stringify({ status: "success", code: "ready" }),
    },
  });
  assert.deepEqual(value, { status: "success", code: "ready" });
});

test("Extella Desktop installer pins hashes for every embedded Expert", async () => {
  const source = await readFile(
    join(ROOT, "integrations", "extella-desktop", "codex-installer.js"),
    "utf8",
  );
  const pairs = [
    ["EXPERT_CODE", "EXPERT_SHA256"],
    ["HEALTH_EXPERT_CODE", "HEALTH_EXPERT_SHA256"],
    ["INSTALL_EXPERT_CODE", "INSTALL_EXPERT_SHA256"],
    ["CREDENTIALS_EXPERT_CODE", "CREDENTIALS_EXPERT_SHA256"],
    ["BRIDGE_EXPERT_CODE", "BRIDGE_EXPERT_SHA256"],
    ["VERIFY_EXPERT_CODE", "VERIFY_EXPERT_SHA256"],
  ];
  for (const [codeName, hashName] of pairs) {
    const assignmentStart = source.indexOf(`var ${codeName} = [`);
    const joinStart = source.indexOf("].join(", assignmentStart);
    const semicolon = source.indexOf(";", joinStart);
    assert.ok(assignmentStart >= 0 && joinStart >= 0 && semicolon >= 0);
    const arrayStart = source.indexOf("[", assignmentStart);
    const expression = source.slice(arrayStart, semicolon);
    const code = Function(`return ${expression}`)();
    const expected = createHash("sha256").update(code).digest("hex");
    const match = source.match(new RegExp(`var ${hashName} = '([a-f0-9]{64})'`));
    assert.equal(match?.[1], expected, hashName);
    const syntax = spawnSync(
      "python3",
      ["-c", "import sys; compile(sys.stdin.read(), '<embedded-expert>', 'exec')"],
      { input: code, encoding: "utf8" },
    );
    assert.equal(syntax.status, 0, `${codeName}: ${syntax.stderr}`);
  }
  assert.match(source, /var PLUGIN_VERSION = '0\.3\.6'/);
  assert.match(source, /"\.extella", "api_token\.txt"/);
  assert.match(source, /installed, plugin_path = installed_plugin\(\)/);
  assert.match(source, /plugin_version_mismatch/);
  assert.match(
    source,
    /verified = subprocess\.run\(\[codex, "plugin", "list", "--json"\]/,
  );
  assert.match(
    source,
    /Independent agent-building standards contract; do not advance with bridge-only releases/,
  );
  assert.match(source, /var EXECUTION_POLICY_VERSION = '1\.0'/);
  assert.match(source, /var DEFAULT_EXECUTION_PROFILE_ID = 'answer-only'/);
  assert.match(source, /return ETB\.api\.resolveAccountScope\(\)/);
  assert.doesNotMatch(source, /QWEN_SETUP_SCOPE/);
  assert.doesNotMatch(source, /agent_extella_alibaba_default/);
  assert.doesNotMatch(source, /0\.2\.1/);
});

test("Codex setup discovers version-manager CLIs and preserves their runtime PATH", async () => {
  const source = await readFile(
    join(ROOT, "integrations", "extella-desktop", "codex-installer.js"),
    "utf8",
  );

  assert.match(source, /"\.nvm", "versions", "node"/);
  assert.match(source, /"\.fnm", "node-versions"/);
  assert.match(source, /"n", "versions", "node"/);
  assert.match(source, /"\.volta", "tools", "image", "node"/);
  assert.match(source, /for flags in \("-ilc", "-lc"\)/);
  assert.match(source, /env\["PATH"\] = ":"\.join\(candidate_roots\(\)/);

  for (const codeName of [
    "HEALTH_EXPERT_CODE",
    "INSTALL_EXPERT_CODE",
    "BRIDGE_EXPERT_CODE",
  ]) {
    const assignmentStart = source.indexOf(`var ${codeName} = [`);
    const joinStart = source.indexOf("].join(", assignmentStart);
    const semicolon = source.indexOf(";", joinStart);
    const arrayStart = source.indexOf("[", assignmentStart);
    const code = Function(`return ${source.slice(arrayStart, semicolon)}`)();
    assert.match(code, /\.nvm/);
    assert.match(code, /-ilc/);
    assert.match(code, /env\["PATH"\] = ":"\.join\(roots/);
  }
});

test("OS setup starts an nvm-installed Codex through its adjacent Node runtime", async (t) => {
  const source = await readFile(
    join(ROOT, "integrations", "extella-desktop", "codex-installer.js"),
    "utf8",
  );
  const assignmentStart = source.indexOf("var EXPERT_CODE = [");
  const joinStart = source.indexOf("].join(", assignmentStart);
  const semicolon = source.indexOf(";", joinStart);
  const arrayStart = source.indexOf("[", assignmentStart);
  const code = Function(`return ${source.slice(arrayStart, semicolon)}`)();
  const home = await mkdtemp(join(tmpdir(), "extella-codex-nvm-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, ".nvm", "versions", "node", "v24.16.0", "bin");
  await mkdir(bin, { recursive: true });

  const executables = {
    "extella-test-node": '#!/bin/sh\nexec /bin/sh "$@"\n',
    node: "#!/bin/sh\nexit 0\n",
    codex: [
      "#!/usr/bin/env extella-test-node",
      'if [ "$1" = "--version" ]; then echo "codex-cli test"; exit 0; fi',
      'if [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in using ChatGPT" >&2; exit 0; fi',
      "exit 1",
      "",
    ].join("\n"),
    git: "#!/bin/sh\nexit 0\n",
    launchctl: "#!/bin/sh\nexit 0\n",
  };
  for (const [name, body] of Object.entries(executables)) {
    const path = join(bin, name);
    await writeFile(path, body, "utf8");
    await chmod(path, 0o755);
  }

  const python = spawnSync(
    "python3",
    ["-"],
    {
      input: [
        "import json, os, platform",
        'platform.system = lambda: "Darwin"',
        code,
        "_real_isfile = os.path.isfile",
        'os.path.isfile = lambda path: _real_isfile(path) if str(path).startswith(os.environ["HOME"]) else False',
        'print(_etb_codex_setup_v2("preflight"))',
        "",
      ].join("\n"),
      encoding: "utf8",
      env: { HOME: home, PATH: "/usr/bin:/bin", SHELL: "/bin/sh" },
    },
  );
  assert.equal(python.status, 0, python.stderr);
  const result = JSON.parse(python.stdout.trim());
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.equal(result.code, "preflight_ok");
  assert.equal(result.codex_version, "codex-cli test");
});

test("Codex credentials use the four canonical token sources without importing an agent id", async () => {
  const source = await readFile(
    join(ROOT, "integrations", "extella-desktop", "codex-installer.js"),
    "utf8",
  );
  const assignmentStart = source.indexOf("var CREDENTIALS_EXPERT_CODE = [");
  const joinStart = source.indexOf("].join(", assignmentStart);
  const semicolon = source.indexOf(";", joinStart);
  const arrayStart = source.indexOf("[", assignmentStart);
  const code = Function(`return ${source.slice(arrayStart, semicolon)}`)();

  const environment = code.indexOf('os.environ.get("EXTELLA_API_TOKEN"');
  const file = code.indexOf('".extella", "api_token.txt"');
  const launchctl = code.indexOf('"/bin/launchctl", "getenv", "EXTELLA_API_TOKEN"');
  const wizard = code.indexOf('"extella_wizard", "app", "config.json"');
  assert.ok(environment >= 0 && environment < file);
  assert.ok(file < launchctl && launchctl < wizard);
  assert.equal(code.slice(wizard).includes("agent_id"), false);
  assert.match(code, /launchctl", "setenv", "EXTELLA_API_TOKEN", token/);
});

test("Codex preflight distinguishes signed-out state from a broken status check", async () => {
  const source = await readFile(
    join(ROOT, "integrations", "extella-desktop", "codex-installer.js"),
    "utf8",
  );
  assert.match(source, /"not logged in" in reported/);
  assert.match(source, /"codex_auth_required"/);
  assert.match(source, /"codex_login_check_failed"/);
  assert.doesNotMatch(source, /\[codex, "login"\]/);
});

test("OS install reports the failing plugin operation without exposing command output", async () => {
  const source = await readFile(
    join(ROOT, "integrations", "extella-desktop", "codex-installer.js"),
    "utf8",
  );
  for (const code of [
    "marketplace_list_failed",
    "marketplace_list_invalid",
    "marketplace_remove_failed",
    "marketplace_add_failed",
    "plugin_install_failed",
    "plugin_verification_failed",
    "plugin_version_mismatch",
  ]) {
    assert.match(source, new RegExp(`"${code}"`));
  }
  assert.doesNotMatch(source, /result\([^\n]+stderr/);
});

test("all deployment scripts resolve storage scope from the current account", async () => {
  const scriptsDir = join(ROOT, "scripts");
  const paths = await filesUnder(scriptsDir);
  const sources = await Promise.all(
    paths.map(async (path) => ({
      name: path.slice(scriptsDir.length + 1),
      source: await readFile(path, "utf8"),
    })),
  );
  assert.ok(sources.length > 0);
  for (const { name, source } of sources) {
    assert.doesNotMatch(
      source,
      /agent_extella_alibaba_default/,
      `${name} must not contain a foreign platform agent id`,
    );
  }
  const deploy = sources.find(({ name }) => name === "deploy-extella-assets.mjs");
  assert.match(deploy?.source ?? "", /postJson\(\s*"\/api\/agent\/list"/);
  assert.match(deploy?.source ?? "", /BOOTSTRAP_AGENT_SCOPE/);
  assert.match(
    deploy?.source ?? "",
    /const accountScope = await resolveAccountScope\(token\)/,
  );
});

test("REST deployment selects only a scope returned by the current account", () => {
  const payload = {
    content: {
      agents: [
        { id: "agent_other", provider: "openai", name: "Other" },
        { agent_id: "agent_account_qwen", provider: "alibaba", name: "Qwen" },
      ],
    },
  };
  assert.equal(accountScopeFromAgentList(payload), "agent_account_qwen");
  assert.throws(
    () => accountScopeFromAgentList({ agents: [] }),
    (error) => error?.code === "account_scope_unavailable",
  );
});

test("standalone Expert matches the code embedded in the desktop adapter", async () => {
  const source = await readFile(
    join(ROOT, "integrations", "extella-desktop", "codex-account-bridge.js"),
    "utf8",
  );
  const assignmentStart = source.indexOf("var CODE = [");
  const joinStart = source.indexOf("].join(", assignmentStart);
  const semicolon = source.indexOf(";", joinStart);
  const arrayStart = source.indexOf("[", assignmentStart);
  const embedded = Function(`return ${source.slice(arrayStart, semicolon)}`)();
  const standalone = await readFile(
    join(ROOT, "experts", "extella_codex_account_bridge_v2.fython"),
    "utf8",
  );
  assert.equal(standalone.trimEnd(), embedded);
  const declaredHash = source.match(/var SHA256 = '([a-f0-9]{64})'/)?.[1];
  assert.equal(
    declaredHash,
    createHash("sha256").update(embedded).digest("hex"),
  );
});

test("REST deployment uses the same persistent-context routing rule", async () => {
  const installer = await readFile(
    join(ROOT, "integrations", "extella-desktop", "codex-installer.js"),
    "utf8",
  );
  assert.equal(RULE_MARKER, "EXTELLA_CODEX_ROUTING_V4");
  assert.match(RULE_TEXT, /Codex mode as active/);
  assert.match(RULE_TEXT, /every later user message/);
  assert.match(RULE_TEXT, /deactivate the mode/);
  assert.match(RULE_TEXT, /never summarize or truncate/);
  assert.match(RULE_TEXT, /execution_profile_id="answer-only"/);
  assert.match(RULE_TEXT, /must always keep its original execution_profile_id/);
  assert.match(RULE_TEXT, /Never pass raw runtime/);
  assert.match(
    installer,
    new RegExp(`ROUTING_RULE_MARKER = '${RULE_MARKER}'`),
  );
  assert.equal(expertCode({ expert_code: "stored" }), "stored");
});
