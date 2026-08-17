#!/usr/bin/env node
// ── CLAUDE LOOPBACK BRIDGE INSTALLER (macOS) ───────────────────────────────
// A second, independent LaunchAgent. It deliberately shares nothing mutable
// with the Codex service: its own label, support directory, state directory,
// port, and secret variable. An isolation mistake on one route therefore
// cannot reach the other, and neither service can be disabled by installing
// the other.
//
// The secret is never written into the LaunchAgent file. The plist names the
// variable to read; the value lives in the user's launchctl environment, the
// same shape the Codex installer already relies on.

import { execFile } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// Two layouts, and the difference is not cosmetic. Shipped to a buyer this
// script arrives inside the listing archive, beside the runtime it installs;
// in the repository it sits in the Claude plugin while the runtime still lives
// in the Codex one. Resolving this from the script's own position means the
// same file works in both, instead of assuming a checkout that a buyer's
// machine does not have.
const ARCHIVE_ROOT = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "extella-codex-bridge");
const RUNTIME_SOURCE_DIR = existsSync(join(ARCHIVE_ROOT, "scripts", "bridge-core.mjs"))
  ? ARCHIVE_ROOT
  : REPO_ROOT;

const LABEL = "ai.extella.claude-bridge";
const SECRET_VARIABLE = "EXTELLA_CLAUDE_BRIDGE_SECRET";
const PORT_VARIABLE = "EXTELLA_CLAUDE_BRIDGE_PORT";
const BINDING_VARIABLE = "EXTELLA_CLAUDE_BRIDGE_ACCOUNT_BINDING";
const DEFAULT_PORT = 18788;

const RUNTIME_SCRIPT_FILES = [
  "bridge-entry.mjs",
  "bridge-core.mjs",
  "bridge-server.mjs",
  "execution-profiles.mjs",
  "extella-guide-source.mjs",
  "invoke-provider.mjs",
  "adapter-claude.mjs",
  "claude-cli-contract.mjs",
];

// Removed before node starts, so a credential that happens to sit in the
// user's launchctl environment cannot reach the bridge process at all. The
// service's own secret is not in this list; nothing else is spared.
const SCRUB_BEFORE_NODE = [
  "EXTELLA_API_TOKEN",
  "EXTELLA_SECONDARY_API_TOKEN",
  "EXTELLA_BRIDGE_SECRET",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "GOOGLE_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
];

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value === "--account-wide") {
      options.accountWide = true;
    } else if (value === "--confirm-account-scope" && next) {
      options.accountScopeConfirmation = next;
      index += 1;
    } else if (value === "--capability" && next) {
      options.capability = next;
      index += 1;
    } else if (value === "--port" && next) {
      options.port = Number.parseInt(next, 10);
      index += 1;
    } else if (value === "--confirm-live-cost" && next) {
      options.liveCostConfirmation = next;
      index += 1;
    } else if (value === "--dry-run") {
      options.dryRun = true;
    } else if (value === "--disable") {
      options.disable = true;
    } else if (value === "--uninstall") {
      options.uninstall = true;
    } else if (value === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${value}`);
    }
  }
  return options;
}

function validateOptions(options) {
  if (options.disable === true || options.uninstall === true) {
    return { disable: options.disable === true, uninstall: options.uninstall === true,
             dryRun: options.dryRun === true };
  }
  if (options.accountWide !== true) {
    throw new Error("--account-wide is required");
  }
  if (options.accountScopeConfirmation !== "I_UNDERSTAND_ALL_AGENTS") {
    throw new Error(
      "Account-wide mode requires --confirm-account-scope I_UNDERSTAND_ALL_AGENTS",
    );
  }
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(options.capability || "")) {
    throw new Error("--capability must use lowercase hyphen-case");
  }
  // Claude is a paid provider on this route, so the confirmation is not
  // optional and there is no mock fallback that would quietly skip it.
  if (options.liveCostConfirmation !== "I_UNDERSTAND_COST") {
    throw new Error("Live Claude requires --confirm-live-cost I_UNDERSTAND_COST");
  }
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("--port must be an integer from 1024 to 65535");
  }
  return { ...options, port };
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function launchctl(args, options = {}) {
  try {
    return await execFileAsync("launchctl", args, { encoding: "utf8" });
  } catch (error) {
    if (options.ignoreFailure) return null;
    throw error;
  }
}

async function getLaunchEnvironment(name) {
  const result = await launchctl(["getenv", name], { ignoreFailure: true });
  return result?.stdout.trim() || "";
}

async function ensureBridgeSecret() {
  const value = await getLaunchEnvironment(SECRET_VARIABLE);
  if (Buffer.byteLength(value, "utf8") >= 32) {
    return { generated: false, previousValue: value, value };
  }
  const generated = randomBytes(32).toString("hex");
  await launchctl(["setenv", SECRET_VARIABLE, generated]);
  return { generated: true, previousValue: value, value: generated };
}

function deriveAccountBinding(secret, token) {
  if (Buffer.byteLength(secret || "", "utf8") < 32) {
    throw new Error("Bridge secret must contain at least 32 bytes");
  }
  if (typeof token !== "string" || token.trim().length < 8) {
    throw new Error("EXTELLA_API_TOKEN must be configured before setup");
  }
  return createHmac("sha256", secret)
    .update(`extella-account-v1.${token.trim()}`, "utf8")
    .digest("hex");
}

async function assertPortAvailable(port) {
  await new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", (error) => {
      rejectPromise(
        new Error(`Port 127.0.0.1:${port} is unavailable: ${error.code}`),
      );
    });
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
    });
  });
}

async function existingConfiguredPort(plistPath) {
  try {
    const source = await readFile(plistPath, "utf8");
    const match = source.match(
      new RegExp(`<key>${PORT_VARIABLE}</key>\\s*<string>(\\d+)</string>`),
    );
    const port = Number.parseInt(match?.[1] || "", 10);
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) return port;
  } catch {
    // A missing plist means this is a first-time setup.
  }
  return null;
}

async function writeRuntime(runtimeDir) {
  await mkdir(join(runtimeDir, "scripts"), { recursive: true, mode: 0o700 });
  await mkdir(join(runtimeDir, "schemas"), { recursive: true, mode: 0o700 });
  for (const filename of RUNTIME_SCRIPT_FILES) {
    await copyFile(
      join(RUNTIME_SOURCE_DIR, "scripts", filename),
      join(runtimeDir, "scripts", filename),
    );
  }
  await copyFile(
    join(RUNTIME_SOURCE_DIR, "schemas", "provider-result.schema.json"),
    join(runtimeDir, "schemas", "provider-result.schema.json"),
  );
}

function plist({
  accountBinding,
  capability,
  claudePath,
  logPath,
  nodePath,
  port,
  runtimeDir,
  stateDir,
  supportDir,
}) {
  const entryPath = join(runtimeDir, "scripts", "bridge-entry.mjs");
  const launchPath = [
    dirname(nodePath),
    dirname(claudePath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(":");
  const scrubArguments = SCRUB_BEFORE_NODE.map(
    (name) => `    <string>-u</string>\n    <string>${xml(name)}</string>`,
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
${scrubArguments}
    <string>${xml(nodePath)}</string>
    <string>${xml(entryPath)}</string>
    <string>--workspace</string>
    <string>${xml(supportDir)}</string>
    <string>--state-dir</string>
    <string>${xml(stateDir)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(supportDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>EXTELLA_BRIDGE_SECRET_NAME</key>
    <string>${SECRET_VARIABLE}</string>
    <key>EXTELLA_BRIDGE_ACCOUNT_BINDINGS</key>
    <string>${xml(accountBinding)}</string>
    <key>EXTELLA_BRIDGE_CAPABILITIES</key>
    <string>${xml(capability)}</string>
    <key>EXTELLA_BRIDGE_ALLOWED_PROVIDERS</key>
    <string>mock,claude</string>
    <key>EXTELLA_BRIDGE_PORT</key>
    <string>${port}</string>
    <key>${PORT_VARIABLE}</key>
    <string>${port}</string>
    <key>CLAUDE_BIN</key>
    <string>${xml(claudePath)}</string>
    <key>PATH</key>
    <string>${xml(launchPath)}</string>
    <key>EXTELLA_AGENT_BUILDER_LIVE</key>
    <string>I_UNDERSTAND_COST</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

async function waitForHealth(port) {
  let lastError;
  let consecutive = 0;
  let payload;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        const body = await response.json();
        if (body.status === "ok" && body.providers?.includes("claude")) {
          consecutive += 1;
          payload = body;
          if (consecutive >= 3) return payload;
        } else {
          consecutive = 0;
          lastError = new Error("Health response did not identify the bridge");
        }
      } else {
        consecutive = 0;
      }
    } catch (error) {
      consecutive = 0;
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Bridge health check failed${lastError ? `: ${lastError.message}` : ""}`,
  );
}

// The exact removal surface, stated rather than implied. The token file is
// deliberately not in files_removed: it is the owner's credential material and
// deleting it is a separate decision, not a side effect of uninstalling a
// service. Nothing here names the Codex label, directory, or variables.
// The plan must describe what this invocation actually does. Disable stops the
// service and leaves every file and variable in place, so that a stopped
// bridge can be started again without reinstalling; uninstall is the one that
// removes things. An earlier version printed the uninstall plan for both,
// which is the kind of report that reads as reassuring and is simply untrue.
function removalPlan({ plistPath, runtimeDir, stateDir, supportDir, uninstall }) {
  const removed = uninstall ? [plistPath, runtimeDir, stateDir, supportDir] : [];
  const retained = uninstall
    ? []
    : [plistPath, supportDir, `${SECRET_VARIABLE}, ${PORT_VARIABLE}, ${BINDING_VARIABLE}`];
  return {
    service: LABEL,
    mode: uninstall ? "uninstall" : "disable",
    stops_service: true,
    files_removed: removed,
    launchctl_variables_unset: uninstall
      ? [SECRET_VARIABLE, PORT_VARIABLE, BINDING_VARIABLE]
      : [],
    kept_for_restart: retained,
    files_retained: [
      `${homedir()}/.extella/mcp (token and headers helper: removed only on a separate explicit decision)`,
    ],
    untouched: [
      "ai.extella.codex-bridge and its LaunchAgent",
      "EXTELLA_BRIDGE_SECRET, EXTELLA_BRIDGE_PORT, EXTELLA_BRIDGE_ACCOUNT_BINDING",
      "EXTELLA_API_TOKEN",
      "~/Library/Application Support/Extella Agent Builder",
      "the Extella MCP server entry in Claude Code (remove with `claude mcp remove`)",
    ],
    idempotent: true,
    model_called: false,
  };
}

function paths() {
  const supportDir = join(
    homedir(),
    "Library",
    "Application Support",
    "Extella Claude Bridge",
  );
  return {
    supportDir,
    runtimeDir: join(supportDir, "runtime"),
    stateDir: join(supportDir, "state"),
    logPath: join(supportDir, "bridge.log"),
    plistPath: join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`),
  };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(
      "Usage: configure-claude-bridge-macos.mjs --account-wide " +
        "--confirm-account-scope I_UNDERSTAND_ALL_AGENTS " +
        "--capability general-assistance " +
        "--confirm-live-cost I_UNDERSTAND_COST [--port 18788] [--dry-run]\n" +
        "       configure-claude-bridge-macos.mjs --disable\n" +
        "       configure-claude-bridge-macos.mjs --uninstall [--dry-run]",
    );
    return;
  }
  if (process.platform !== "darwin") {
    throw new Error("Persistent bridge setup currently supports macOS only");
  }
  const { supportDir, runtimeDir, stateDir, logPath, plistPath } = paths();
  const domain = `gui/${process.getuid()}`;
  const existingPort =
    parsed.disable || parsed.uninstall ? null : await existingConfiguredPort(plistPath);
  const options = validateOptions(
    parsed.port == null && existingPort != null
      ? { ...parsed, port: existingPort }
      : parsed,
  );

  if (options.disable || options.uninstall) {
    const plan = removalPlan({
      plistPath, runtimeDir, stateDir, supportDir,
      uninstall: options.uninstall === true,
    });
    if (options.dryRun) {
      console.log(JSON.stringify({ status: "removal_planned", ...plan }, null, 2));
      return;
    }
    // Scoped to this service by construction: one label, one plist, one
    // support directory, and three variables whose names all carry CLAUDE.
    // Nothing here can reach the Codex service or its environment.
    await launchctl(["bootout", domain, plistPath], { ignoreFailure: true });
    await launchctl(["disable", `${domain}/${LABEL}`], { ignoreFailure: true });
    const removed = [];
    const unset = [];
    if (options.uninstall) {
      for (const name of plan.launchctl_variables_unset) {
        await launchctl(["unsetenv", name], { ignoreFailure: true });
        unset.push(name);
      }
      for (const path of plan.files_removed) {
        try {
          await rm(path, { recursive: true, force: true });
          removed.push(path);
        } catch {
          // force:true already ignores a missing path, so a repeat run is a
          // no-op rather than an error.
        }
      }
    }
    console.log(
      JSON.stringify(
        {
          status: options.uninstall ? "uninstalled" : "disabled",
          mode: plan.mode,
          service: LABEL,
          // Same key names as the plan, so the two can be compared directly.
          files_removed: removed,
          launchctl_variables_unset: unset,
          files_retained: plan.files_retained,
          model_called: false,
        },
        null,
        2,
      ),
    );
    return;
  }

  const claudePath = (
    await execFileAsync("/usr/bin/which", ["claude"], { encoding: "utf8" })
  ).stdout.trim();
  if (!claudePath.startsWith("/")) {
    throw new Error("Could not resolve an absolute Claude CLI path");
  }

  // A dry run proves the whole plan without touching launchd, the user's
  // environment, or the port. It is what the test suite exercises.
  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          status: "planned",
          service: LABEL,
          port: options.port,
          secret_variable: SECRET_VARIABLE,
          provider: "claude",
          authorization_scope: "account",
          plist_path: plistPath,
          runtime_files: RUNTIME_SCRIPT_FILES,
          scrubbed_before_node: SCRUB_BEFORE_NODE,
          model_called: false,
        },
        null,
        2,
      ),
    );
    return;
  }

  await launchctl(["bootout", domain, plistPath], { ignoreFailure: true });
  const previousPort = await getLaunchEnvironment(PORT_VARIABLE);
  const previousBinding = await getLaunchEnvironment(BINDING_VARIABLE);
  let secretState = { generated: false, previousValue: "", value: "" };
  let health;
  try {
    await assertPortAvailable(options.port);
    await mkdir(supportDir, { recursive: true, mode: 0o700 });
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await mkdir(dirname(plistPath), { recursive: true });
    await writeRuntime(runtimeDir);
    secretState = await ensureBridgeSecret();
    const token = await getLaunchEnvironment("EXTELLA_API_TOKEN");
    const accountBinding = deriveAccountBinding(secretState.value, token);
    await launchctl(["setenv", BINDING_VARIABLE, accountBinding]);
    await launchctl(["setenv", PORT_VARIABLE, String(options.port)]);
    await writeFile(
      plistPath,
      plist({
        accountBinding,
        capability: options.capability,
        claudePath,
        logPath,
        nodePath: process.execPath,
        port: options.port,
        runtimeDir,
        stateDir,
        supportDir,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(plistPath, 0o600);
    await launchctl(["enable", `${domain}/${LABEL}`]);
    await launchctl(["bootstrap", domain, plistPath]);
    health = await waitForHealth(options.port);
  } catch (error) {
    await launchctl(["bootout", domain, plistPath], { ignoreFailure: true });
    await launchctl(["disable", `${domain}/${LABEL}`], { ignoreFailure: true });
    if (previousPort) await launchctl(["setenv", PORT_VARIABLE, previousPort]);
    else await launchctl(["unsetenv", PORT_VARIABLE], { ignoreFailure: true });
    if (previousBinding) await launchctl(["setenv", BINDING_VARIABLE, previousBinding]);
    else await launchctl(["unsetenv", BINDING_VARIABLE], { ignoreFailure: true });
    if (secretState.previousValue) {
      await launchctl(["setenv", SECRET_VARIABLE, secretState.previousValue]);
    } else if (secretState.generated) {
      await launchctl(["unsetenv", SECRET_VARIABLE], { ignoreFailure: true });
    }
    throw new Error(`Bridge setup failed and was rolled back: ${error.message}`);
  }

  console.log(
    JSON.stringify(
      {
        status: "configured",
        service: LABEL,
        authorization_scope: "account",
        capability: options.capability,
        provider: "claude",
        port: options.port,
        model_called: false,
        health,
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(`configure-claude-bridge-macos: ${error.message}`);
    process.exitCode = 1;
  });
}

export {
  BINDING_VARIABLE,
  DEFAULT_PORT,
  LABEL,
  PORT_VARIABLE,
  RUNTIME_SCRIPT_FILES,
  SCRUB_BEFORE_NODE,
  SECRET_VARIABLE,
  assertPortAvailable,
  deriveAccountBinding,
  existingConfiguredPort,
  main,
  parseArgs,
  paths,
  plist,
  removalPlan,
  validateOptions,
  writeRuntime,
};
