import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  describeSource,
  localSource,
  pinnedSource,
} from "../../extella-claude-bridge/scripts/set-marketplace-source.mjs";
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
  // multi-line concatenation, so phrases are split across string literals and
  // a substring search silently misses them.
  const declarations = source.slice(
    source.indexOf("var ROUTING_RULE_MARKER"),
    source.indexOf("var _running"),
  );
  const rule = Function(`${declarations}\nreturn ROUTING_RULE_TEXT;`)();

  assert.ok(rule.startsWith("EXTELLA_CLAUDE_ROUTING_V1:"));
  assert.ok(rule.includes("extella_claude_account_bridge_v1"));
  assert.equal(rule.includes("EXTELLA_CODEX_ROUTING"), false);
  assert.equal(rule.includes("extella_codex_account_bridge"), false);

  // Measured on a live agent: it called run_expert without global=true and the
  // platform answered "Expert not found", though the Expert exists and is
  // visible from every scope. The first edition mentioned the flag mid-
  // paragraph after "otherwise"; it now leads, and the recovery is named.
  // The flag must sit in the sentence that names the call, not merely early in
  // the text: a first edition that only warned about it further down is what
  // the agent skipped. Removing it from that sentence must fail this test.
  const callSentence = rule.split(". ").find((part) => part.includes("run_expert"));
  assert.ok(callSentence, "the rule must name the call form");
  assert.ok(callSentence.includes("global=true"),
    "global=true must be in the same sentence as the call form");
  // Both refusals the platform actually produces must be named with their
  // remedy: the wrong scope, and the wrong machine.
  // Both refusals the platform produces are named with what they mean.
  assert.ok(rule.includes("Expert not found"));
  assert.ok(rule.includes("Повторять бесполезно"));
  assert.ok(rule.includes("bridge_not_configured"));
  assert.ok(rule.includes("search_targets"));
  // A cloud agent on a Claude model is not the local bridge.
  assert.ok(rule.includes("другого агента на модели Claude"));

  assert.ok(rule.includes("run_agent"));
  assert.ok(rule.includes("не запускай второго агента"));
  assert.ok(rule.includes("не переиспользуй conversation_id из другого"));
  assert.ok(rule.includes('execution_profile_id="answer-only"'));
  assert.ok(rule.includes("сырые флаги рантайма"));
});test("the Claude and Codex installers share no pinned identity", async () => {
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

test("an unreadable install state stops, instead of restarting from scratch", async () => {
  const source = await readFile(INSTALLER, "utf8");
  const stateBody = source.slice(
    source.indexOf("function installState("),
    source.indexOf("function _writeConnectionState"),
  );
  // Answering STEPS[0] on failure meant a transient error silently re-ran
  // install, credentials, and bridge on a host where all three were done —
  // the blind repetition this path exists to prevent.
  assert.equal(stateBody.includes("resumeFrom: STEPS[0]"), false);
  assert.ok(stateBody.includes("unknown: true"));
  assert.ok(stateBody.includes("resumeFrom: null"));

  const installBody = source.slice(source.indexOf("function install(options)"));
  assert.ok(installBody.includes("install_state_unknown"));
  // Starting over remains possible, but only as an explicit decision.
  assert.ok(installBody.includes("options.forceFullInstall !== true"));
});

// ── The published source must be pinned ────────────────────────────────────

test("a marketplace source is either a local path or a pinned tag", () => {
  assert.deepEqual(describeSource(localSource()),
    { kind: "local", pinned: false, detail: "./plugins/extella-claude-bridge" });
  assert.equal(describeSource(pinnedSource("v0.2.0")).pinned, true);
  assert.equal(describeSource(pinnedSource("v0.2.0-rc.1")).pinned, true);

  // `claude plugin marketplace add` has no --ref flag, so pinning lives in the
  // manifest. A branch satisfies the schema and gives a floating source.
  for (const floating of ["main", "HEAD", "release"]) {
    assert.throws(() => pinnedSource(floating), /floating source/, `${floating} must be refused`);
  }
  for (const bad of [{ source: "github", owner: "x", repo: "y", ref: "main" },
                     { source: "github", owner: "x", repo: "y" },
                     "plugins/extella-claude-bridge",
                     null]) {
    assert.equal(describeSource(bad).kind, "invalid");
  }
});

test("the shipped manifest declares a source this project accepts", async () => {
  const manifest = JSON.parse(
    await readFile(resolve(CLAUDE_PLUGIN, "..", "..", ".claude-plugin", "marketplace.json"), "utf8"),
  );
  const plugin = manifest.plugins.find((entry) => entry.name === "extella-claude-bridge");
  assert.ok(plugin, "the plugin must be listed");
  assert.notEqual(describeSource(plugin.source).kind, "invalid");
});
