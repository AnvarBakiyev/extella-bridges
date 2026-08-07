import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import { scrubCredentialEnvironment } from "../scripts/bridge-entry.mjs";
import { createBridgeServer, signRequest } from "../scripts/bridge-core.mjs";
import { deriveAccountBinding } from "../scripts/configure-bridge-macos.mjs";
import {
  ProviderAdapterError,
  codexArguments,
  safeProviderDiagnostic,
} from "../scripts/invoke-provider.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const SECRET = "test-secret-with-at-least-thirty-two-bytes";
const BINDING = "a".repeat(64);

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
});

test("another Extella account binding is rejected", async (t) => {
  const { server, url } = await startBridge();
  t.after(() => server.close());
  const response = await signedPost(url, body({ account_binding: "b".repeat(64) }));
  assert.equal(response.status, 403);
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

test("global Expert is loopback-only and supports 2000 output tokens", async () => {
  const expert = await readFile(
    join(ROOT, "experts", "extella_codex_account_bridge_v2.fython"),
    "utf8",
  );
  assert.match(expert, /127\.0\.0\.1/);
  assert.match(expert, /max_output_tokens: int = 2000/);
  assert.match(expert, /max_output_tokens > 2000/);
  assert.match(expert, /urllib\.error\.HTTPError/);
  assert.doesNotMatch(expert, /https?:\/\/(?!127\.0\.0\.1)/);
});

test("MCP configuration uses environment references and contains no tokens", async () => {
  const source = await readFile(join(ROOT, ".mcp.json"), "utf8");
  const config = JSON.parse(source);
  assert.equal(config.mcpServers.extella_primary.bearer_token_env_var, "EXTELLA_API_TOKEN");
  assert.equal(config.mcpServers.extella_secondary.bearer_token_env_var, "EXTELLA_SECONDARY_API_TOKEN");
  assert.doesNotMatch(source, /Bearer\s+[A-Za-z0-9._-]+/);
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
  }
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
});
