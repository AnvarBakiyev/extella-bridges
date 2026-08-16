import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { secretVariableName } from "../scripts/bridge-server.mjs";
import { SCRUB_BEFORE_NODE as CODEX_SCRUB } from "../scripts/configure-bridge-macos.mjs";
import {
  BINDING_VARIABLE,
  DEFAULT_PORT,
  LABEL,
  PORT_VARIABLE,
  RUNTIME_SCRIPT_FILES,
  SCRUB_BEFORE_NODE,
  SECRET_VARIABLE,
  deriveAccountBinding,
  existingConfiguredPort,
  paths,
  plist,
  removalPlan,
  validateOptions,
  writeRuntime,
} from "../../extella-claude-bridge/scripts/configure-claude-bridge-macos.mjs";

const CLAUDE_PLUGIN = resolve(import.meta.dirname, "..", "..", "extella-claude-bridge");
const SECRET = "0".repeat(64);
const TOKEN = "extella-token-that-must-not-appear-anywhere";

function samplePlist(overrides = {}) {
  return plist({
    accountBinding: "a".repeat(64),
    capability: "general-assistance",
    claudePath: "/opt/homebrew/bin/claude",
    logPath: "/tmp/x/bridge.log",
    nodePath: "/opt/homebrew/bin/node",
    port: DEFAULT_PORT,
    runtimeDir: "/tmp/x/runtime",
    stateDir: "/tmp/x/state",
    supportDir: "/tmp/x",
    ...overrides,
  });
}

// ── The two services must not be able to disturb each other ────────────────

test("the Claude service shares no label, port, or secret with the Codex one", async () => {
  // Read rather than imported: the Codex installer keeps its label private,
  // and this also fails if that label ever changes underneath us.
  const codexSource = await readFile(
    resolve(import.meta.dirname, "..", "scripts", "configure-bridge-macos.mjs"),
    "utf8",
  );
  assert.ok(codexSource.includes('const LABEL = "ai.extella.codex-bridge"'));
  assert.notEqual(LABEL, "ai.extella.codex-bridge");
  assert.equal(LABEL, "ai.extella.claude-bridge");
  assert.equal(SECRET_VARIABLE, "EXTELLA_CLAUDE_BRIDGE_SECRET");
  assert.notEqual(SECRET_VARIABLE, "EXTELLA_BRIDGE_SECRET");
  assert.notEqual(DEFAULT_PORT, 8787);
  assert.notEqual(DEFAULT_PORT, 18787);
  const { supportDir, stateDir } = paths();
  assert.ok(supportDir.includes("Extella Claude Bridge"));
  assert.equal(stateDir.includes("Extella Agent Builder"), false);
});

test("the Claude service scrubs the Codex secret, and vice versa", () => {
  // Neither service may inherit the other's secret, and the Codex list is
  // left exactly as it was.
  assert.ok(SCRUB_BEFORE_NODE.includes("EXTELLA_BRIDGE_SECRET"));
  assert.equal(SCRUB_BEFORE_NODE.includes(SECRET_VARIABLE), false);
  assert.equal(CODEX_SCRUB.includes("EXTELLA_BRIDGE_SECRET"), false);
  for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "EXTELLA_API_TOKEN"]) {
    assert.ok(SCRUB_BEFORE_NODE.includes(name), `${name} must be scrubbed`);
  }
});

test("the secret variable name is validated, not taken on trust", () => {
  assert.equal(secretVariableName(undefined), "EXTELLA_BRIDGE_SECRET");
  assert.equal(secretVariableName(SECRET_VARIABLE), SECRET_VARIABLE);
  for (const bad of ["PATH", "EXTELLA_BRIDGE_SECRET_EVIL", "../x", ""]) {
    if (bad === "") continue;
    assert.throws(() => secretVariableName(bad), `${bad} must be refused`);
  }
});

// ── The secret pointer is not itself a secret ──────────────────────────────

test("the scrub spares the secret pointer and the variable it names", async () => {
  const { scrubCredentialEnvironment } = await import("../scripts/bridge-entry.mjs");
  const environment = {
    PATH: "/usr/bin",
    EXTELLA_BRIDGE_SECRET_NAME: SECRET_VARIABLE,
    [SECRET_VARIABLE]: "z".repeat(64),
    EXTELLA_API_TOKEN: "must be removed",
    ANTHROPIC_API_KEY: "must be removed",
  };
  const removed = scrubCredentialEnvironment(environment);

  // Measured on the first live install attempt: the pointer matches the
  // SECRET pattern, so it was being scrubbed along with real credentials. The
  // server then fell back to the default variable, which the LaunchAgent had
  // deliberately unset, and the service died at startup.
  assert.equal(environment.EXTELLA_BRIDGE_SECRET_NAME, SECRET_VARIABLE);
  assert.equal(environment[SECRET_VARIABLE], "z".repeat(64));
  assert.deepEqual(removed, ["ANTHROPIC_API_KEY", "EXTELLA_API_TOKEN"]);
});

test("a pointer naming something that is not a secret variable is ignored", async () => {
  const { scrubCredentialEnvironment } = await import("../scripts/bridge-entry.mjs");
  const environment = {
    EXTELLA_BRIDGE_SECRET_NAME: "PATH",
    EXTELLA_API_TOKEN: "must be removed",
  };
  scrubCredentialEnvironment(environment);
  // The pointer is validated where it is read; sparing an arbitrary name here
  // would let it nominate any variable as untouchable.
  assert.equal(environment.EXTELLA_API_TOKEN, undefined);
});

// ── The LaunchAgent file must never carry a secret ─────────────────────────

test("the LaunchAgent names the secret variable and never contains its value", () => {
  const source = samplePlist();
  assert.ok(source.includes("<key>EXTELLA_BRIDGE_SECRET_NAME</key>"));
  assert.ok(source.includes(`<string>${SECRET_VARIABLE}</string>`));
  assert.equal(source.includes(SECRET), false);
  assert.equal(source.includes(TOKEN), false);
  // The scrub runs before node starts, inside ProgramArguments.
  for (const name of SCRUB_BEFORE_NODE) {
    assert.ok(source.includes(`<string>${name}</string>`), `${name} must be scrubbed`);
  }
  assert.ok(source.includes("<string>mock,claude</string>"));
  assert.ok(source.includes("<key>EXTELLA_AGENT_BUILDER_LIVE</key>"));
});

test("the LaunchAgent escapes values instead of trusting them", () => {
  const source = samplePlist({ supportDir: '/tmp/<evil>&"path"' });
  assert.equal(source.includes("<evil>"), false);
  assert.ok(source.includes("&lt;evil&gt;"));
});

test("an existing installation keeps its port", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "extella-claude-port-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "bridge.plist");
  await readFile(path).catch(() => {});
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, `<key>${PORT_VARIABLE}</key>\n<string>18999</string>\n`, "utf8");
  assert.equal(await existingConfiguredPort(path), 18999);
});

// ── Confirmations are not optional ─────────────────────────────────────────

test("setup refuses to proceed without both explicit confirmations", () => {
  const base = { accountWide: true, capability: "general-assistance" };
  assert.throws(() => validateOptions({ ...base }), /confirm-account-scope/);
  assert.throws(
    () =>
      validateOptions({
        ...base,
        accountScopeConfirmation: "I_UNDERSTAND_ALL_AGENTS",
      }),
    /confirm-live-cost/,
  );
  assert.throws(
    () =>
      validateOptions({
        capability: "general-assistance",
        accountScopeConfirmation: "I_UNDERSTAND_ALL_AGENTS",
        liveCostConfirmation: "I_UNDERSTAND_COST",
      }),
    /--account-wide/,
  );
  const ok = validateOptions({
    ...base,
    accountScopeConfirmation: "I_UNDERSTAND_ALL_AGENTS",
    liveCostConfirmation: "I_UNDERSTAND_COST",
  });
  assert.equal(ok.port, DEFAULT_PORT);
});

test("the account binding is derived and carries no token", () => {
  const first = deriveAccountBinding(SECRET, TOKEN);
  assert.equal(first, deriveAccountBinding(SECRET, TOKEN));
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first.includes("extella-token"), false);
  assert.notEqual(first, deriveAccountBinding("1".repeat(64), TOKEN));
  assert.throws(() => deriveAccountBinding(SECRET, "short"));
});

// ── The installed runtime must be complete ─────────────────────────────────

test("the installed Claude runtime carries every module it imports", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "extella-claude-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimeDir = join(directory, "runtime");
  await writeRuntime(runtimeDir);
  const installed = await readdir(join(runtimeDir, "scripts"));
  const bundled = new Set(RUNTIME_SCRIPT_FILES);
  assert.deepEqual(installed.sort(), [...bundled].sort());
  for (const filename of bundled) {
    const source = await readFile(join(runtimeDir, "scripts", filename), "utf8");
    for (const match of source.matchAll(/(?:from\s+|import\()\s*["']\.\/([^"']+)["']/g)) {
      assert.ok(
        bundled.has(match[1]),
        `${filename} imports ${match[1]}, which is absent from the runtime bundle`,
      );
    }
  }
  assert.ok(bundled.has("adapter-claude.mjs"));
});

// ── The setup Expert ───────────────────────────────────────────────────────

const EXPERT_PATH = join(CLAUDE_PLUGIN, "experts", "extella_claude_product_setup.py");
const STEPS = ["preflight", "install", "credentials", "bridge", "verify"];

test("the setup Expert implements exactly the five agreed steps", async () => {
  const source = await readFile(EXPERT_PATH, "utf8");
  for (const step of STEPS) {
    assert.ok(source.includes(`action == "${step}"`), `${step} must be handled`);
  }
  assert.ok(source.includes('"unsupported_step"'));
});

test("every Expert result is a JSON string and carries the cost contract", async () => {
  const source = await readFile(EXPERT_PATH, "utf8");
  // H17: a returned dict reaches the page as a Python repr, not JSON.
  assert.match(source, /return json\.dumps\(payload, ensure_ascii=False\)/);
  assert.doesNotMatch(source, /^\s+return \{/m);
  for (const field of ['"model_called": False', '"agent_called": False', '"paid": False']) {
    assert.ok(source.includes(field), `${field} must be in every result`);
  }
  // Every return in the body goes through result(...) or the payload builder.
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("return ")) continue;
    assert.ok(
      /^return (result\(|json\.dumps\(|None|"" |""$|\(|agent_id|payload)/.test(trimmed) ||
        trimmed.startsWith("return (probe.stdout") ||
        trimmed.startsWith("return \"acct_\"") ||
        trimmed.startsWith("return value") ||
        trimmed.startsWith("return found") ||
        trimmed.startsWith("return candidate") ||
        trimmed.startsWith("return env") ||
        trimmed.startsWith("return item") ||
        trimmed.startsWith("return [item") ||
        trimmed.startsWith("return payload.get") ||
        trimmed.startsWith("return []") ||
        trimmed.startsWith("return subprocess.run"),
      `unexpected return shape: ${trimmed}`,
    );
  }
});

test("the Expert never signs in for the owner and never starts an agent", async () => {
  const source = await readFile(EXPERT_PATH, "utf8");
  // The remedy must be named to the owner, but never executed for them.
  assert.equal(source.includes('"auth", "login"'), false);
  assert.equal(source.includes('"login"'), false);
  assert.ok(source.includes("claude_auth_required"));
  assert.ok(source.includes("claude auth login"), "the remedy must be named to the owner");
  assert.equal(source.includes("run_agent"), false);
  // Subprocesses are launched without a shell and with a scrubbed environment.
  assert.match(source, /shell=False/);
  assert.equal(source.includes("shell=True"), false);
  for (const name of ["EXTELLA_API_TOKEN", "ANTHROPIC_API_KEY", "EXTELLA_CLAUDE_BRIDGE_SECRET"]) {
    assert.ok(source.includes(`"${name}"`), `${name} must be popped from the child env`);
  }
});

test("verification proves the binding by token validation, not by MCP connectivity", async () => {
  const source = await readFile(EXPERT_PATH, "utf8");
  assert.ok(source.includes("api/token/validate"));
  assert.ok(source.includes('account_binding_proved_by="token_validate"'));
  // Measured: `claude mcp list` prints a connected label for a server with no
  // token at all. The Expert may check presence, but must never branch on it.
  // Comments are stripped first: prose explaining the trap is not the trap.
  const code = source
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");
  assert.doesNotMatch(code, /Connected/);
  assert.ok(source.includes("mcp_connection_missing"));
});

test("the MCP connector is written as a helper, never as a literal header", async () => {
  const source = await readFile(EXPERT_PATH, "utf8");
  assert.ok(source.includes("headersHelper"));
  assert.equal(source.includes('"headers"'), false);
  assert.equal(source.includes("--header"), false);
  // The token file and the helper are created with restrictive modes.
  assert.ok(source.includes("0o600"));
  assert.ok(source.includes("0o700"));
  // All three Extella headers, with a resolved agent id.
  for (const header of ["X-Auth-Token", "X-Profile-Id", "X-Agent-Id"]) {
    assert.ok(source.includes(header), `${header} must be sent`);
  }
  assert.equal(source.includes("agent_extella_default"), false);
});

test("the setup Expert calls no model on any step", async () => {
  const source = await readFile(EXPERT_PATH, "utf8");
  // The only Claude invocations are version, auth status, plugin, and mcp
  // management. None of them runs the model.
  const invocations = [...source.matchAll(/\[claude,\s*"([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(invocations)].sort(),
    ["--version", "auth", "mcp", "plugin"],
  );
  assert.equal(source.includes('"-p"'), false);
});

// ── Measured plugin-list shape ─────────────────────────────────────────────

test("the plugin parser matches the measured shape, which has no name key", async () => {
  const fixture = JSON.parse(
    await readFile(join(import.meta.dirname, "fixtures", "claude-plugin-list.json"), "utf8"),
  );
  // Recorded from Claude Code 2.1.81 on 2026-08-14.
  assert.ok(Array.isArray(fixture), "the top level is a bare array, not an object");
  assert.equal(
    fixture.some((entry) => "name" in entry),
    false,
    "no entry carries a name key",
  );
  for (const key of ["id", "version", "scope", "enabled", "installPath"]) {
    assert.ok(key in fixture[0], `${key} must be present`);
  }
  const ours = fixture.find((entry) => entry.id === "extella-claude-bridge@extella-claude");
  assert.ok(ours, "the fixture must contain our own entry");
  // A git-sourced plugin reports a commit SHA where a semantic version would
  // otherwise sit, so setup records the value instead of comparing it.
  assert.match(ours.version, /^[0-9a-f]{12}$/);
});

test("setup identifies the plugin by id and enablement, never by name", async () => {
  const source = await readFile(EXPERT_PATH, "utf8");
  assert.match(source, /item\.get\("id"\) == PLUGIN and item\.get\("enabled"\) is True/);
  // Measured: plugin list entries have no "name". Marketplace entries do, so
  // the ban is scoped to how the plugin itself is identified.
  const pluginLookup = source.slice(
    source.indexOf("def installed_plugin"),
    source.indexOf("def handle_for"),
  );
  assert.equal(pluginLookup.includes('"name"'), false);
  assert.ok(source.includes('PLUGIN = "extella-claude-bridge@extella-claude"'));
  // The tolerant dict fallback stays, but the array is the expectation.
  assert.ok(source.includes("isinstance(payload, list)"));
});

// ── Rollback contract ──────────────────────────────────────────────────────

test("removal touches only the Claude service", () => {
  const plan = removalPlan({
    plistPath: "/tmp/x/ai.extella.claude-bridge.plist",
    runtimeDir: "/tmp/x/runtime",
    stateDir: "/tmp/x/state",
    supportDir: "/tmp/x",
  });
  assert.equal(plan.service, LABEL);
  const serialized = JSON.stringify(plan.files_removed) + JSON.stringify(plan.launchctl_variables_unset);
  assert.equal(serialized.includes("codex"), false);
  assert.equal(serialized.includes("Extella Agent Builder"), false);
  for (const name of plan.launchctl_variables_unset) {
    assert.match(name, /^EXTELLA_CLAUDE_BRIDGE_/, `${name} must be Claude-scoped`);
  }
  // The Codex secret, port, binding, and account token are named as untouched.
  const untouched = plan.untouched.join(" ");
  for (const name of ["EXTELLA_BRIDGE_SECRET", "EXTELLA_API_TOKEN", "codex-bridge"]) {
    assert.ok(untouched.includes(name), `${name} must be declared untouched`);
  }
  assert.equal(plan.idempotent, true);
  assert.equal(plan.model_called, false);
});

test("uninstall never deletes the account credential as a side effect", () => {
  const plan = removalPlan({
    plistPath: "/tmp/x/p.plist",
    runtimeDir: "/tmp/x/runtime",
    stateDir: "/tmp/x/state",
    supportDir: "/tmp/x",
  });
  assert.equal(
    plan.files_removed.some((path) => path.includes(".extella/mcp")),
    false,
    "the token and helper are credential material, not service state",
  );
  assert.ok(plan.files_retained.join(" ").includes(".extella/mcp"));
  assert.ok(plan.files_retained.join(" ").includes("separate explicit decision"));
});

test("removal is idempotent because every step tolerates absence", async () => {
  const source = await readFile(
    join(CLAUDE_PLUGIN, "scripts", "configure-claude-bridge-macos.mjs"),
    "utf8",
  );
  assert.ok(source.includes('rm(path, { recursive: true, force: true })'));
  assert.match(source, /unsetenv[\s\S]{0,80}ignoreFailure: true/);
  assert.match(source, /bootout[\s\S]{0,120}ignoreFailure: true/);
});

// ── Resuming a partial install ─────────────────────────────────────────────

test("a partial install can be read and resumed instead of blindly repeated", async () => {
  const source = await readFile(EXPERT_PATH, "utf8");
  assert.ok(source.includes('action == "status"'));
  assert.ok(source.includes('"resume_from"') || source.includes("resume_from="));
  for (const step of ["install", "credentials", "bridge"]) {
    assert.ok(source.includes(`"${step}"`), `${step} must appear in the status map`);
  }
  // The status step reads only: no marketplace, plugin, mcp add, or launchctl
  // setenv may appear after it.
  const statusBody = source.slice(source.indexOf('if action == "status"'));
  for (const forbidden of ["setenv", "add-json", "marketplace", "add"]) {
    assert.equal(
      statusBody.includes(`"${forbidden}"`),
      false,
      `${forbidden} must not run during a status read`,
    );
  }
});

// ── Rollback contract ──────────────────────────────────────────────────────

const REMOVAL_PATHS = {
  plistPath: "/tmp/x/ai.extella.claude-bridge.plist",
  runtimeDir: "/tmp/x/runtime",
  stateDir: "/tmp/x/state",
  supportDir: "/tmp/x",
};

test("disable stops the service and removes nothing", () => {
  const plan = removalPlan({ ...REMOVAL_PATHS, uninstall: false });
  assert.equal(plan.mode, "disable");
  assert.equal(plan.stops_service, true);
  // An earlier version printed the uninstall plan for both, which reads as
  // reassuring and is simply untrue.
  assert.deepEqual(plan.files_removed, []);
  assert.deepEqual(plan.launchctl_variables_unset, []);
  assert.ok(plan.kept_for_restart.length > 0);
});

test("uninstall removes only Claude files and only Claude variables", () => {
  const plan = removalPlan({ ...REMOVAL_PATHS, uninstall: true });
  assert.equal(plan.mode, "uninstall");
  assert.deepEqual(plan.files_removed, [
    REMOVAL_PATHS.plistPath,
    REMOVAL_PATHS.runtimeDir,
    REMOVAL_PATHS.stateDir,
    REMOVAL_PATHS.supportDir,
  ]);
  for (const name of plan.launchctl_variables_unset) {
    assert.ok(name.startsWith("EXTELLA_CLAUDE_"), `${name} is not a Claude variable`);
  }
  assert.equal(plan.launchctl_variables_unset.includes("EXTELLA_BRIDGE_SECRET"), false);
  assert.equal(plan.launchctl_variables_unset.includes("EXTELLA_API_TOKEN"), false);
  assert.equal(plan.idempotent, true);
  assert.equal(plan.model_called, false);
});

test("neither mode touches the Codex service or the account token", () => {
  for (const uninstall of [false, true]) {
    const plan = removalPlan({ ...REMOVAL_PATHS, uninstall });
    const serialized = JSON.stringify(plan.files_removed);
    assert.equal(serialized.includes("Extella Agent Builder"), false);
    assert.equal(serialized.includes("codex"), false);
    const untouched = plan.untouched.join(" ");
    assert.ok(untouched.includes("codex-bridge"));
    assert.ok(untouched.includes("EXTELLA_API_TOKEN"));
  }
});

test("the token file is never removed without a separate decision", () => {
  const plan = removalPlan({ ...REMOVAL_PATHS, uninstall: true });
  const retained = plan.files_retained.join(" ");
  assert.ok(retained.includes(".extella/mcp"));
  assert.ok(retained.includes("separate explicit decision"));
  // Match the token directory, not the service label: "ai.extella.claude-bridge"
  // legitimately contains ".extella".
  assert.equal(JSON.stringify(plan.files_removed).includes(".extella/mcp"), false);
  for (const path of plan.files_removed) {
    assert.equal(path.includes("/.extella/"), false, `${path} must not be removed`);
  }
});
