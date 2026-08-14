import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createBridgeServer, signRequest } from "../scripts/bridge-core.mjs";
import { invokeProvider, conversationPath } from "../scripts/invoke-provider.mjs";
import {
  claudeChildEnvironment,
  claudeConversationPath,
  inspectManagedSettings,
  invokeClaude,
  parseClaudeOutput,
} from "../scripts/adapter-claude.mjs";
import {
  claudeDelegationArguments,
  isSessionId,
} from "../scripts/claude-cli-contract.mjs";
import {
  accountHandle,
  environmentName,
  mcpConfigFragment,
  mergeAccountConfig,
  serverName,
} from "../../extella-claude-bridge/scripts/extella-mcp-accounts.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const FAKE_CLAUDE = join(ROOT, "test", "fixtures", "bin", "fake-claude");
const SECRET = "test-secret-with-at-least-thirty-two-bytes";
const BINDING = "a".repeat(64);
const OTHER_BINDING = "b".repeat(64);
const FIRST_SESSION = "11111111-1111-4111-8111-111111111111";
const SECOND_SESSION = "22222222-2222-4222-8222-222222222222";

// The Claude route reads the public Extella guide exactly like the Codex
// route. Tests must not reach the network, so the loader is injected.
const guideLoader = async () => ({
  contentVersion: "2026-08-14.4",
  context: "Canonical Extella guide snapshot (test stub).",
  sourceUrls: [],
});

// The adapter hands its child an allowlisted environment, so the fixture
// cannot be steered with environment variables — the first run of this suite
// proved that by starving the fixture of its own configuration. A per-test
// copy of the binary with an inlined control-file path is used instead.
async function installFakeClaude(directory, mode) {
  const controlPath = join(directory, "fake-claude-control.json");
  const binaryPath = join(directory, "fake-claude");
  const argsLog = join(directory, "claude-args.jsonl");
  const envLog = join(directory, "claude-env.jsonl");
  const template = await readFile(FAKE_CLAUDE, "utf8");
  await writeFile(
    binaryPath,
    template.replace("__FAKE_CLAUDE_CONTROL__", controlPath),
    { encoding: "utf8", mode: 0o700 },
  );
  await writeFile(
    controlPath,
    JSON.stringify({ mode, argsLog, envLog }),
    "utf8",
  );
  return { binaryPath, argsLog, envLog };
}

async function withClaudeEnvironment(t, mode = "ok") {
  const directory = await mkdtemp(join(tmpdir(), "extella-claude-poc-"));
  const { binaryPath, argsLog, envLog } = await installFakeClaude(directory, mode);
  const previous = {
    CLAUDE_BIN: process.env.CLAUDE_BIN,
    EXTELLA_AGENT_BUILDER_LIVE: process.env.EXTELLA_AGENT_BUILDER_LIVE,
  };
  process.env.CLAUDE_BIN = binaryPath;
  process.env.EXTELLA_AGENT_BUILDER_LIVE = "I_UNDERSTAND_COST";
  t.after(async () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  return {
    argsLog,
    envLog,
    directory,
    stateDir: join(directory, "state"),
    workspace: join(directory, "workspace"),
  };
}

async function readJsonLines(path) {
  try {
    return (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function delegate(environment, overrides = {}) {
  return invokeProvider({
    provider: "claude",
    live: true,
    guideLoader,
    accountBinding: BINDING,
    eventId: `evt_${randomUUID().replaceAll("-", "")}`,
    prompt: "Synthetic delegation for the fake Claude binary.",
    workspace: environment.workspace,
    stateDir: environment.stateDir,
    ...overrides,
  });
}

// ── Isolation of setting sources, hooks, MCP, memory, and skills ───────────

test("delegation argv disables every ambient Claude Code input", async (t) => {
  const environment = await withClaudeEnvironment(t);
  await delegate(environment);
  const [argv] = await readJsonLines(environment.argsLog);
  assert.ok(argv, "the fake Claude binary must have been invoked once");

  const pairs = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith("--")) pairs.set(argv[index], argv[index + 1]);
  }

  // user, project, and local settings are all skipped.
  assert.equal(pairs.get("--setting-sources"), "");
  // Hooks, custom status line, and auto memory are switched off for the run.
  const settings = JSON.parse(pairs.get("--settings"));
  assert.equal(settings.disableAllHooks, true);
  assert.equal(settings.autoMemoryEnabled, false);
  assert.equal(settings.enableAllProjectMcpServers, false);
  // No MCP server can be inherited from anywhere.
  assert.ok(argv.includes("--strict-mcp-config"));
  assert.deepEqual(JSON.parse(pairs.get("--mcp-config")), { mcpServers: {} });
  // No tools and no user-invocable skills.
  assert.equal(pairs.get("--tools"), "");
  assert.ok(argv.includes("--disable-slash-commands"));
  assert.equal(pairs.get("--permission-mode"), "dontAsk");
  assert.equal(pairs.get("--max-turns"), "1");
  // Structured output is requested by schema, not parsed out of free text.
  assert.ok(pairs.has("--json-schema"));
  assert.equal(argv[0], "-p");
});

test("forbidden Claude Code flags never reach the child process", async (t) => {
  const environment = await withClaudeEnvironment(t);
  await delegate(environment);
  const [argv] = await readJsonLines(environment.argsLog);
  for (const flag of [
    "--continue",
    "-c",
    "--fork-session",
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
    "--add-dir",
    "--no-session-persistence",
  ]) {
    assert.equal(argv.includes(flag), false, `${flag} must not be passed`);
  }
});

test("the prompt travels on stdin and never appears in argv", async (t) => {
  const environment = await withClaudeEnvironment(t);
  const secretish = "canary-prompt-must-not-reach-the-process-table";
  await delegate(environment, { prompt: secretish });
  const [argv] = await readJsonLines(environment.argsLog);
  assert.equal(argv.join(" ").includes(secretish), false);
});

test("CLAUDE.md, memory, and credentials are absent from the child environment", async (t) => {
  const environment = await withClaudeEnvironment(t);
  const injected = {
    EXTELLA_API_TOKEN: "extella-token-must-not-leak",
    EXTELLA_BRIDGE_SECRET: SECRET,
    ANTHROPIC_API_KEY: "anthropic-key-must-not-leak",
    OPENAI_API_KEY: "openai-key-must-not-leak",
    GITHUB_TOKEN: "gh-token-must-not-leak",
    CLAUDE_CODE_ENABLE_SOMETHING: "inherited-noise",
  };
  Object.assign(process.env, injected);
  t.after(() => {
    for (const name of Object.keys(injected)) delete process.env[name];
  });

  await delegate(environment);
  const [childEnvironment] = await readJsonLines(environment.envLog);
  for (const name of Object.keys(injected)) {
    assert.equal(childEnvironment[name], undefined, `${name} must be dropped`);
  }
  const serialized = JSON.stringify(childEnvironment);
  for (const value of Object.values(injected)) {
    assert.equal(serialized.includes(value), false);
  }
  // Auto memory is switched off at the environment level too, because a
  // managed setting could otherwise re-enable autoMemoryEnabled.
  assert.equal(childEnvironment.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  assert.equal(childEnvironment.NO_COLOR, "1");
  assert.equal(childEnvironment.TERM, "dumb");
});

test("the environment filter is an allowlist, not a name-pattern denylist", () => {
  const child = claudeChildEnvironment({
    PATH: "/usr/bin",
    HOME: "/Users/example",
    LC_ALL: "en_US.UTF-8",
    // None of these match a SECRET/TOKEN/KEY pattern, so a denylist would
    // have let every one of them through.
    AWS_PROFILE: "production",
    GIT_ASKPASS: "/tmp/evil",
    NODE_OPTIONS: "--require /tmp/evil.js",
    EXTELLA_BRIDGE_ACCOUNT_BINDING: BINDING,
  });
  assert.equal(child.PATH, "/usr/bin");
  assert.equal(child.LC_ALL, "en_US.UTF-8");
  assert.equal(child.AWS_PROFILE, undefined);
  assert.equal(child.GIT_ASKPASS, undefined);
  assert.equal(child.NODE_OPTIONS, undefined);
  assert.equal(child.EXTELLA_BRIDGE_ACCOUNT_BINDING, undefined);
});

test("the delegated run uses the bridge workspace, not the caller's directory", async (t) => {
  const environment = await withClaudeEnvironment(t);
  const result = await delegate(environment);
  assert.equal(result.status, "completed");
  // A -p session shows no workspace-trust dialog, so the working directory is
  // the only thing standing between a delegation and a project's own hooks.
  assert.notEqual(resolve(environment.workspace), resolve(process.cwd()));
});

// ── Managed settings fail closed ───────────────────────────────────────────

test("managed settings carrying hooks stop the run before the model", async (t) => {
  const environment = await withClaudeEnvironment(t);
  await assert.rejects(
    invokeClaude({
      accountBinding: BINDING,
      eventId: "evt_managed_hooks",
      executionProfile: { id: "answer-only", policyVersion: "1.0" },
      managedSettingsInspector: async () => ({
        present: true,
        unreadable: false,
        files: ["/Library/Application Support/ClaudeCode/managed-settings.json"],
        risky: ["hooks"],
      }),
      maxOutputTokens: 200,
      prompt: "must never run",
      stateDir: environment.stateDir,
      timeoutMs: 5000,
      workspace: environment.workspace,
    }),
    (error) => error?.diagnostic?.code === "claude_managed_settings_conflict",
  );
  assert.deepEqual(await readJsonLines(environment.argsLog), []);
});

test("unreadable managed settings are treated as hostile, not absent", async (t) => {
  const environment = await withClaudeEnvironment(t);
  await assert.rejects(
    invokeClaude({
      accountBinding: BINDING,
      eventId: "evt_managed_unreadable",
      executionProfile: { id: "answer-only", policyVersion: "1.0" },
      managedSettingsInspector: async () => ({
        present: true,
        unreadable: true,
        files: [],
        risky: [],
      }),
      maxOutputTokens: 200,
      prompt: "must never run",
      stateDir: environment.stateDir,
      timeoutMs: 5000,
      workspace: environment.workspace,
    }),
    (error) => error?.diagnostic?.code === "claude_managed_settings_unreadable",
  );
  assert.deepEqual(await readJsonLines(environment.argsLog), []);
});

test("managed settings inspection reads the documented platform paths", async () => {
  const seen = [];
  const report = await inspectManagedSettings({
    platform: "darwin",
    readDirectory: async () => ["10-policy.json", "notes.txt"],
    readTextFile: async (path) => {
      seen.push(path);
      return JSON.stringify({ hooks: {} });
    },
  });
  assert.deepEqual(seen, [
    "/Library/Application Support/ClaudeCode/managed-settings.json",
    "/Library/Application Support/ClaudeCode/managed-settings.d/10-policy.json",
  ]);
  assert.equal(report.present, true);
  assert.deepEqual(report.risky, ["hooks"]);
});

// ── Sessions ───────────────────────────────────────────────────────────────

test("the first delegation returns an opaque conversation id and hides the session id", async (t) => {
  const environment = await withClaudeEnvironment(t);
  const result = await delegate(environment);
  assert.match(result.conversation_id, /^ctx_[A-Za-z0-9_-]{32,64}$/);
  assert.equal(JSON.stringify(result).includes(FIRST_SESSION), false);
  const [argv] = await readJsonLines(environment.argsLog);
  assert.equal(argv.includes("--resume"), false);
});

test("a second turn in the same chat resumes exactly that session", async (t) => {
  const environment = await withClaudeEnvironment(t);
  const first = await delegate(environment);
  const second = await delegate(environment, {
    conversationId: first.conversation_id,
  });
  assert.equal(second.conversation_id, first.conversation_id);
  const calls = await readJsonLines(environment.argsLog);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][calls[1].indexOf("--resume") + 1], FIRST_SESSION);
});

test("two Extella chats never share a Claude session", async (t) => {
  const environment = await withClaudeEnvironment(t);
  const first = await delegate(environment);
  const second = await delegate(environment);
  assert.notEqual(first.conversation_id, second.conversation_id);
  const firstRecord = JSON.parse(
    await readFile(
      claudeConversationPath({
        accountBinding: BINDING,
        conversationId: first.conversation_id,
        stateDir: environment.stateDir,
      }),
      "utf8",
    ),
  );
  const secondRecord = JSON.parse(
    await readFile(
      claudeConversationPath({
        accountBinding: BINDING,
        conversationId: second.conversation_id,
        stateDir: environment.stateDir,
      }),
      "utf8",
    ),
  );
  assert.equal(firstRecord.claude_session_id, FIRST_SESSION);
  assert.equal(secondRecord.claude_session_id, SECOND_SESSION);
  assert.notEqual(firstRecord.claude_session_id, secondRecord.claude_session_id);
});

test("another Extella account cannot resume this conversation", async (t) => {
  const environment = await withClaudeEnvironment(t);
  const first = await delegate(environment);
  await assert.rejects(
    delegate(environment, {
      accountBinding: OTHER_BINDING,
      conversationId: first.conversation_id,
    }),
    (error) => error?.diagnostic?.code === "claude_conversation_not_found",
  );
});

test("a saved conversation keeps its original execution profile", async (t) => {
  const environment = await withClaudeEnvironment(t);
  const first = await delegate(environment);
  await assert.rejects(
    invokeClaude({
      accountBinding: BINDING,
      conversationId: first.conversation_id,
      eventId: "evt_profile_swap",
      executionProfile: { id: "some-other-profile", policyVersion: "1.0" },
      maxOutputTokens: 200,
      prompt: "profile swap must fail closed",
      stateDir: environment.stateDir,
      timeoutMs: 5000,
      workspace: environment.workspace,
    }),
    (error) =>
      error?.diagnostic?.code === "claude_conversation_profile_mismatch",
  );
});

// ── Provider namespace isolation ───────────────────────────────────────────

test("Codex and Claude conversation ids with the same value never collide", async (t) => {
  const environment = await withClaudeEnvironment(t);
  const shared = `ctx_${"a".repeat(40)}`;
  const codexPath = conversationPath({
    accountBinding: BINDING,
    conversationId: shared,
    stateDir: environment.stateDir,
  });
  const claudePath = claudeConversationPath({
    accountBinding: BINDING,
    conversationId: shared,
    stateDir: environment.stateDir,
  });
  assert.notEqual(codexPath, claudePath);
  // The Codex layout is unchanged; Claude adds one literal path segment that a
  // 64-hex account directory can never equal.
  assert.equal(codexPath.includes(`${"/"}claude${"/"}`), false);
  assert.ok(claudePath.includes(`${"/"}claude${"/"}`));
});

test("a Claude conversation id is not accepted from the Codex namespace", async (t) => {
  const environment = await withClaudeEnvironment(t);
  const first = await delegate(environment);
  await assert.rejects(
    invokeProvider({
      provider: "codex",
      live: true,
      guideLoader,
      accountBinding: BINDING,
      conversationId: first.conversation_id,
      eventId: "evt_cross_provider",
      prompt: "Codex must not see a Claude conversation.",
      workspace: environment.workspace,
      stateDir: environment.stateDir,
    }),
    (error) => error?.diagnostic?.code === "codex_conversation_not_found",
  );
});

// ── Output parsing ─────────────────────────────────────────────────────────

const REJECTED_OUTPUT_MODES = [
  ["repr", "claude_output_invalid_json"],
  ["truncated", "claude_output_invalid_json"],
  ["no_session", "claude_session_id_missing"],
  ["bad_session", "claude_session_id_missing"],
  ["no_structured", "claude_structured_output_missing"],
  ["bad_schema", "claude_result_schema_invalid"],
  ["event_mismatch", "claude_result_schema_invalid"],
  ["error_flag", "claude_reported_error"],
];

for (const [mode, code] of REJECTED_OUTPUT_MODES) {
  test(`a ${mode.replaceAll("_", " ")} response is not a success`, async (t) => {
    const environment = await withClaudeEnvironment(t, mode);
    await assert.rejects(
      delegate(environment),
      (error) => error?.diagnostic?.code === code,
      `${mode} should fail with ${code}`,
    );
  });
}

test("a rejected response leaves no resumable conversation behind", async (t) => {
  const environment = await withClaudeEnvironment(t, "no_session");
  await assert.rejects(delegate(environment));
  await assert.rejects(
    stat(join(environment.stateDir, "conversations", "claude")),
    (error) => error?.code === "ENOENT",
  );
});

test("a Python repr is rejected rather than guessed at", () => {
  assert.throws(
    () =>
      parseClaudeOutput(
        "{'session_id': '11111111-1111-4111-8111-111111111111', 'is_error': False}",
        "evt_repr",
      ),
    (error) => error?.diagnostic?.code === "claude_output_invalid_json",
  );
});

// ── Authentication is checked without calling a model ──────────────────────

test("a signed-out Claude Code reports a visible code and starts nothing", async (t) => {
  const environment = await withClaudeEnvironment(t, "auth_logged_out");
  await assert.rejects(
    delegate(environment),
    (error) => error?.diagnostic?.code === "claude_auth_required",
  );
  assert.deepEqual(
    await readJsonLines(environment.argsLog),
    [],
    "no delegated run may start without a signed-in Claude Code",
  );
});

test("an unparsable auth status is a failure, not an assumption of success", async (t) => {
  const environment = await withClaudeEnvironment(t, "auth_broken");
  await assert.rejects(
    delegate(environment),
    (error) => error?.diagnostic?.code === "claude_auth_status_invalid",
  );
  assert.deepEqual(await readJsonLines(environment.argsLog), []);
});

test("the auth check never surfaces the account email or organisation", async (t) => {
  const environment = await withClaudeEnvironment(t);
  const result = await delegate(environment);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("fixture-user@example.test"), false);
  assert.equal(serialized.includes("Fixture Org"), false);
  assert.equal(serialized.includes("00000000-0000-4000-8000-000000000000"), false);
  assert.equal(result.cost_guard.subscription_type, "max");
});

// ── Cost posture ───────────────────────────────────────────────────────────

test("no spend ceiling is promised under subscription authentication", async (t) => {
  const environment = await withClaudeEnvironment(t);
  const result = await delegate(environment);
  assert.equal(result.cost_guard.spend_ceiling_enforced, false);
  assert.equal(result.cost_guard.observed_total_cost_usd, 0.0123);
  assert.equal(result.cost_guard.max_turns, 1);
  const [argv] = await readJsonLines(environment.argsLog);
  assert.equal(argv.includes("--max-budget-usd"), false);
});

test("a Claude delegation without the live cost confirmation is refused", async (t) => {
  const environment = await withClaudeEnvironment(t);
  delete process.env.EXTELLA_AGENT_BUILDER_LIVE;
  await assert.rejects(
    delegate(environment),
    (error) =>
      error?.diagnostic?.code === "claude_live_cost_confirmation_required",
  );
  assert.deepEqual(await readJsonLines(environment.argsLog), []);
});

// ── Bridge contract ────────────────────────────────────────────────────────

async function startBridge(allowedProviders) {
  const server = createBridgeServer({
    secret: SECRET,
    allowedAccountBindings: [BINDING],
    allowedCapabilities: ["general-assistance"],
    allowedProviders,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}/v1/delegate` };
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
      "X-Extella-Signature": signRequest({ secret: SECRET, timestamp, nonce, rawBody }),
    },
    body: rawBody,
  });
}

function claudeBody(overrides = {}) {
  return {
    schema_version: "1.3",
    event_id: `evt_${randomUUID().replaceAll("-", "")}`,
    account_binding: BINDING,
    capability: "general-assistance",
    provider: "claude",
    execution_profile_id: "answer-only",
    prompt: "Synthetic bridge test.",
    budget: { max_output_tokens: 200, timeout_ms: 5000 },
    ...overrides,
  };
}

test("the Claude provider is refused unless the bridge enables it", async (t) => {
  const { server, url } = await startBridge(["mock"]);
  t.after(() => server.close());
  const response = await signedPost(url, claudeBody());
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "provider_not_allowed");
});

test("raw Claude runtime flags cannot cross the bridge contract", async (t) => {
  const { server, url } = await startBridge(["mock", "claude"]);
  t.after(() => server.close());
  for (const extra of [
    { setting_sources: "user" },
    { dangerously_skip_permissions: true },
    { cwd: "/Users/example/private-repo" },
  ]) {
    const response = await signedPost(url, claudeBody(extra));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "invalid_request");
  }
});

// ── Per-account Extella MCP connections ────────────────────────────────────

test("each Extella account derives its own stable server name and variable", () => {
  const first = "extella-token-account-one-abcdefgh";
  const second = "extella-token-account-two-ijklmnop";
  const firstHandle = accountHandle(first);
  const secondHandle = accountHandle(second);

  assert.equal(firstHandle, accountHandle(first), "the handle must be stable");
  assert.notEqual(firstHandle, secondHandle);
  assert.match(firstHandle, /^acct_[a-f0-9]{12}$/);
  assert.notEqual(serverName(firstHandle), serverName(secondHandle));
  assert.notEqual(environmentName(firstHandle), environmentName(secondHandle));
  assert.match(environmentName(firstHandle), /^EXTELLA_MCP_TOKEN_ACCT_[A-F0-9]{12}$/);
});

test("an MCP entry references a variable and never carries the token", () => {
  const token = "extella-token-that-must-never-be-written-down";
  const handle = accountHandle(token);
  const fragment = mcpConfigFragment(handle);
  const serialized = JSON.stringify(fragment);

  assert.equal(serialized.includes(token), false);
  assert.equal(
    fragment.mcpServers[serverName(handle)].headers["X-Auth-Token"],
    `\${${environmentName(handle)}}`,
  );
  // No default value: an unset variable must show up as a missing-variable
  // warning in `claude mcp list` rather than silently resolving.
  assert.equal(serialized.includes(":-"), false);
});

test("configuring a second account leaves the first one intact", () => {
  const firstHandle = accountHandle("extella-token-account-one-abcdefgh");
  const secondHandle = accountHandle("extella-token-account-two-ijklmnop");
  const afterFirst = mergeAccountConfig({}, firstHandle);
  const afterSecond = mergeAccountConfig(afterFirst, secondHandle);

  assert.deepEqual(
    Object.keys(afterSecond.mcpServers).sort(),
    [serverName(firstHandle), serverName(secondHandle)].sort(),
  );
  assert.deepEqual(
    afterSecond.mcpServers[serverName(firstHandle)],
    afterFirst.mcpServers[serverName(firstHandle)],
  );
  // Re-running setup for one account must be idempotent.
  assert.deepEqual(mergeAccountConfig(afterSecond, firstHandle), afterSecond);
});

test("the shipped Claude plugin manifest stores no account material", async () => {
  const manifest = JSON.parse(
    await readFile(
      resolve(ROOT, "..", "extella-claude-bridge", ".claude-plugin", "plugin.json"),
      "utf8",
    ),
  );
  // userConfig holds one value per key, so it cannot represent two accounts
  // without overwriting one. It is therefore absent by design.
  assert.equal("userConfig" in manifest, false);
  assert.equal("mcpServers" in manifest, false);
  const marketplace = JSON.parse(
    await readFile(
      resolve(ROOT, "..", "..", ".claude-plugin", "marketplace.json"),
      "utf8",
    ),
  );
  assert.equal(marketplace.plugins[0].name, "extella-claude-bridge");
});

// ── Source-level guarantees ────────────────────────────────────────────────

test("the Claude Expert talks only to loopback and returns strict JSON", async () => {
  const expert = await readFile(
    resolve(
      ROOT,
      "..",
      "extella-claude-bridge",
      "experts",
      "extella_claude_account_bridge_v1.fython",
    ),
    "utf8",
  );
  assert.match(expert, /127\.0\.0\.1/);
  assert.doesNotMatch(expert, /https?:\/\/(?!127\.0\.0\.1)/);
  assert.match(expert, /\) -> str:/);
  assert.match(expert, /def strict_json\(payload\):/);
  assert.doesNotMatch(expert, /^\s+return\s+(?:result|\{)/m);
  assert.match(expert, /"provider": "claude"/);
  // A separate secret and port: the Claude service must not ride on the Codex
  // one, so an isolation mistake in one cannot silently affect the other.
  assert.match(expert, /EXTELLA_CLAUDE_BRIDGE_SECRET/);
  assert.match(expert, /EXTELLA_CLAUDE_BRIDGE_PORT/);
  assert.doesNotMatch(expert, /run_agent/);
});

test("no Claude source in this repository names a bypass flag", async () => {
  const sources = await Promise.all(
    [
      join(ROOT, "scripts", "adapter-claude.mjs"),
      join(ROOT, "scripts", "claude-cli-contract.mjs"),
    ].map((path) => readFile(path, "utf8")),
  );
  for (const source of sources) {
    for (const flag of [
      '"--dangerously-skip-permissions"',
      '"--allow-dangerously-skip-permissions"',
      '"--continue"',
      '"--fork-session"',
      '"--bare"',
    ]) {
      assert.equal(source.includes(flag), false, `${flag} must not appear`);
    }
  }
});

test("resume arguments are rejected for anything that is not a session id", () => {
  assert.equal(isSessionId(FIRST_SESSION), true);
  assert.equal(isSessionId("../../another-session"), false);
  assert.throws(() => claudeDelegationArguments({ sessionId: "nope" }));
  assert.equal(claudeDelegationArguments().includes("--resume"), false);
});
