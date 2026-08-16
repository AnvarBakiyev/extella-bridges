import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const CLAUDE_PLUGIN = resolve(import.meta.dirname, "..", "..", "extella-claude-bridge");
const DESKTOP = join(CLAUDE_PLUGIN, "integrations", "extella-desktop");
const INSTALLER = join(DESKTOP, "claude-installer.js");
const ACCOUNT_BRIDGE = join(DESKTOP, "claude-account-bridge.js");

function embeddedArray(source, name) {
  const start = source.indexOf(`var ${name} = [`);
  const join = source.indexOf("].join(", start);
  const semicolon = source.indexOf(";", join);
  assert.ok(start >= 0 && join >= 0 && semicolon >= 0, `${name} must be extractable`);
  return Function(`return ${source.slice(source.indexOf("[", start), semicolon)}`)();
}

function declaredHash(source, name) {
  return source.match(new RegExp(`var ${name} = '([a-f0-9]{64})'`))?.[1];
}

// ── The shipped copy must match the file on disk ───────────────────────────

test("the installer ships the setup Expert verbatim, with a matching digest", async () => {
  const source = await readFile(INSTALLER, "utf8");
  const embedded = embeddedArray(source, "EXPERT_CODE");
  const onDisk = (
    await readFile(join(CLAUDE_PLUGIN, "experts", "extella_claude_product_setup.py"), "utf8")
  ).replace(/\r?\n$/, "");
  // An Expert that lives in one place and ships from another drifts, and the
  // drift stays invisible until a customer runs the older copy.
  assert.equal(embedded, onDisk);
  assert.equal(declaredHash(source, "EXPERT_SHA256"),
    createHash("sha256").update(embedded).digest("hex"));
});

test("the account bridge ships its Expert verbatim, with a matching digest", async () => {
  const source = await readFile(ACCOUNT_BRIDGE, "utf8");
  const embedded = embeddedArray(source, "CODE");
  const onDisk = (
    await readFile(
      join(CLAUDE_PLUGIN, "experts", "extella_claude_account_bridge_v1.fython"), "utf8")
  ).replace(/\r?\n$/, "");
  assert.equal(embedded, onDisk);
  assert.equal(declaredHash(source, "SHA256"),
    createHash("sha256").update(embedded).digest("hex"));
});

// ── The iframe chooses nothing ─────────────────────────────────────────────

test("every mutable value is pinned in the installer, not supplied by a caller", async () => {
  const source = await readFile(INSTALLER, "utf8");
  assert.match(source, /var EXPERT_NAME = 'extella_claude_product_setup'/);
  assert.match(source, /var PLUGIN_VERSION = '0\.1\.0-poc'/);
  assert.match(source, /var BRIDGE_PORT = 18788/);
  // install() accepts only progress reporting and the vetted source path.
  const installBody = source.slice(source.indexOf("function install(options)"));
  for (const forbidden of ["options.expertName", "options.command", "options.code",
                           "options.token", "options.repository", "options.ref",
                           "options.target", "options.port"]) {
    assert.equal(installBody.includes(forbidden), false, `${forbidden} must not be accepted`);
  }
});

// ── Setup must never spend the user's plan ─────────────────────────────────

test("a step reporting any cost is treated as a failure", async () => {
  const source = await readFile(INSTALLER, "utf8");
  const body = source.match(
    /function _parseRunResult\(response\) \{([\s\S]*?)\n  \}\n/,
  )?.[1];
  assert.ok(body, "_parseRunResult must remain extractable for contract testing");
  const parse = Function(`return function (response) {${body}\n}`)();

  const clean = { status: "success", code: "ready", model_called: false,
                  agent_called: false, paid: false };
  assert.deepEqual(parse({ result: { result: JSON.stringify(clean) } }), clean);

  // H17: both envelopes, and a Python repr is refused rather than guessed at.
  assert.throws(() => parse({ result: "{'status': 'success'}" }), /некорректный результат/);
  assert.throws(() => parse({ result: JSON.stringify({ status: "success" }) }),
    /не той формой/);

  for (const spent of ["model_called", "agent_called", "paid"]) {
    assert.throws(
      () => parse({ result: JSON.stringify({ ...clean, [spent]: true }) }),
      (error) => error.code === "unexpected_cost",
      `${spent} must fail the step`,
    );
  }
  assert.throws(
    () => parse({ result: JSON.stringify({ ...clean, status: "error", code: "boom" }) }),
    (error) => error.code === "boom",
  );
});

// ── Connectivity is not evidence ───────────────────────────────────────────

test("connection status requires both measured proofs, not a connected flag", async () => {
  const source = await readFile(INSTALLER, "utf8");
  const body = source.slice(source.indexOf("function connectionStatus()"));
  // Measured: an MCP initialize answers alike with a valid token, no token,
  // and a wrong one, so it can never stand in for either proof.
  assert.ok(body.includes("account_binding_proved_by === 'token_validate'"));
  assert.ok(body.includes("mcp_authentication_proved_by === 'mcp_tools_call'"));
  assert.equal(body.includes("'Connected'"), false);
});

// ── Resume rather than repeat ──────────────────────────────────────────────

test("installation resumes from the reported gap instead of repeating steps", async () => {
  const source = await readFile(INSTALLER, "utf8");
  assert.ok(source.includes("function installState("));
  assert.ok(source.includes("'status'"), "status is read before any step runs");
  assert.match(source, /pending = STEPS\.slice\(STEPS\.indexOf\(state\.resumeFrom\)\)/);
  const steps = embeddedSteps(source);
  assert.deepEqual(steps, ["preflight", "install", "credentials", "bridge", "verify"]);
});

function embeddedSteps(source) {
  return Function(
    `return ${source.match(/var STEPS = (\[[^\]]*\])/)[1]}`,
  )();
}

// ── The routing rule keeps the two providers apart ─────────────────────────

test("the routing rule is Claude-specific and forbids run_agent", async () => {
  const source = await readFile(INSTALLER, "utf8");
  // Evaluate the declarations rather than grepping the file: the rule is a
  // multi-line concatenation, so phrases like "Never use run_agent" are split
  // across string literals and a substring search silently misses them.
  const declarations = source.slice(
    source.indexOf("var ROUTING_RULE_MARKER"),
    source.indexOf("var _running"),
  );
  const rule = Function(`${declarations}\nreturn ROUTING_RULE_TEXT;`)();

  assert.ok(rule.startsWith("EXTELLA_CLAUDE_ROUTING_V1:"));
  assert.ok(rule.includes("extella_claude_account_bridge_v1"));
  // A marker or Expert name shared with the Codex rule would let one route's
  // mode flip the other's.
  assert.equal(rule.includes("EXTELLA_CODEX_ROUTING"), false);
  assert.equal(rule.includes("extella_codex_account_bridge"), false);
  assert.ok(rule.includes("Never use run_agent"));
  assert.ok(rule.includes("never start another Extella agent"));
  assert.ok(rule.includes("Never reuse a conversation_id from another chat"));
  assert.ok(rule.includes('execution_profile_id="answer-only"'));
  assert.ok(rule.includes("Never pass raw runtime"));
});
test("the Claude and Codex installers share no pinned identity", async () => {
  const [claude, codex] = await Promise.all([
    readFile(INSTALLER, "utf8"),
    readFile(
      resolve(import.meta.dirname, "..", "integrations", "extella-desktop",
              "codex-installer.js"),
      "utf8"),
  ]);
  assert.notEqual(declaredHash(claude, "EXPERT_SHA256"), declaredHash(codex, "EXPERT_SHA256"));
  for (const shared of ["extella:codex-connection", "ETB.codexAccountBridge",
                        "_etb_codex_setup_v2"]) {
    assert.equal(claude.includes(shared), false, `${shared} must not appear`);
  }
  assert.ok(claude.includes("extella:claude-connection:v1"));
  assert.equal(codex.includes("ETB.claudeInstaller"), false);
});
