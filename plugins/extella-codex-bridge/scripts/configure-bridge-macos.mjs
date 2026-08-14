#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(SCRIPT_DIR, "..");
const LABEL = "ai.extella.codex-bridge";
const RUNTIME_SCRIPT_FILES = [
  "bridge-entry.mjs",
  "bridge-core.mjs",
  "bridge-server.mjs",
  "execution-profiles.mjs",
  "extella-guide-source.mjs",
  "invoke-provider.mjs",
  // Claude adapter modules. They are part of the module graph, so the bundle
  // must carry them, but no installer path enables the Claude provider yet:
  // validateOptions still accepts only mock and codex.
  "adapter-claude.mjs",
  "claude-cli-contract.mjs",
];
const SCRUB_BEFORE_NODE = [
  "EXTELLA_API_TOKEN",
  "EXTELLA_SECONDARY_API_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "ANTHROPIC_API_KEY",
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
    if (value === "--agent-id" && next) {
      options.agentId = next;
      index += 1;
    } else if (value === "--account-wide") {
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
    } else if (value === "--provider" && next) {
      options.provider = next;
      index += 1;
    } else if (value === "--confirm-live-cost" && next) {
      options.liveCostConfirmation = next;
      index += 1;
    } else if (value === "--disable") {
      options.disable = true;
    } else if (value === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${value}`);
    }
  }
  return options;
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function validateOptions(options) {
  if (options.disable === true) {
    if (
      options.agentId ||
      options.accountWide ||
      options.accountScopeConfirmation ||
      options.capability ||
      options.port ||
      options.provider ||
      options.liveCostConfirmation
    ) {
      throw new Error("--disable cannot be combined with target options");
    }
    return { disable: true };
  }
  const accountWide = options.accountWide === true;
  if (accountWide) {
    if (options.agentId) {
      throw new Error("--account-wide cannot be combined with --agent-id");
    }
    if (options.accountScopeConfirmation !== "I_UNDERSTAND_ALL_AGENTS") {
      throw new Error(
        "Account-wide mode requires " +
          "--confirm-account-scope I_UNDERSTAND_ALL_AGENTS",
      );
    }
  } else {
    if (!/^agent_[A-Za-z0-9_-]{8,128}$/.test(options.agentId || "")) {
      throw new Error("--agent-id must contain a stable Extella agent ID");
    }
    if (options.accountScopeConfirmation) {
      throw new Error(
        "--confirm-account-scope is valid only with --account-wide",
      );
    }
  }
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(options.capability || "")) {
    throw new Error("--capability must use lowercase hyphen-case");
  }
  const port = options.port ?? 8787;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("--port must be an integer from 1024 to 65535");
  }
  const provider = options.provider || "mock";
  if (!["mock", "codex"].includes(provider)) {
    throw new Error("--provider must equal mock or codex");
  }
  if (
    provider === "codex" &&
    options.liveCostConfirmation !== "I_UNDERSTAND_COST"
  ) {
    throw new Error(
      "Live Codex requires --confirm-live-cost I_UNDERSTAND_COST",
    );
  }
  if (provider === "mock" && options.liveCostConfirmation) {
    throw new Error("--confirm-live-cost is valid only for Codex");
  }
  return { ...options, port, provider };
}

async function launchctl(args, options = {}) {
  try {
    return await execFileAsync("launchctl", args, { encoding: "utf8" });
  } catch (error) {
    if (options.ignoreFailure) {
      return null;
    }
    throw error;
  }
}

async function getLaunchEnvironment(name) {
  const result = await launchctl(["getenv", name], {
    ignoreFailure: true,
  });
  return result?.stdout.trim() || "";
}

async function ensureBridgeSecret() {
  const value = await getLaunchEnvironment("EXTELLA_BRIDGE_SECRET");
  if (Buffer.byteLength(value, "utf8") >= 32) {
    return { generated: false, previousValue: value, value };
  }
  const generated = randomBytes(32).toString("hex");
  await launchctl(["setenv", "EXTELLA_BRIDGE_SECRET", generated]);
  return { generated: true, previousValue: value, value: generated };
}

function deriveAccountBinding(secret, token) {
  if (Buffer.byteLength(secret || "", "utf8") < 32) {
    throw new Error("Bridge secret must contain at least 32 bytes");
  }
  if (typeof token !== "string" || token.trim().length < 8) {
    throw new Error(
      "EXTELLA_API_TOKEN must be configured before account-wide setup",
    );
  }
  return createHmac("sha256", secret)
    .update(`extella-account-v1.${token.trim()}`, "utf8")
    .digest("hex");
}

async function restoreLaunchEnvironment(name, previousValue) {
  if (previousValue) {
    await launchctl(["setenv", name, previousValue]);
    return;
  }
  await launchctl(["unsetenv", name]);
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
      server.close((error) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise();
      });
    });
  });
}

async function existingConfiguredPort(plistPath) {
  try {
    const source = await readFile(plistPath, "utf8");
    const match = source.match(
      /<key>EXTELLA_BRIDGE_PORT<\/key>\s*<string>(\d+)<\/string>/,
    );
    const port = Number.parseInt(match?.[1] || "", 10);
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
      return port;
    }
  } catch {
    // A missing or unreadable plist means this is a first-time setup.
  }
  return null;
}

async function writeRuntime(runtimeDir) {
  await mkdir(join(runtimeDir, "scripts"), { recursive: true, mode: 0o700 });
  await mkdir(join(runtimeDir, "schemas"), { recursive: true, mode: 0o700 });
  for (const filename of RUNTIME_SCRIPT_FILES) {
    await copyFile(
      join(PLUGIN_DIR, "scripts", filename),
      join(runtimeDir, "scripts", filename),
    );
  }
  await copyFile(
    join(PLUGIN_DIR, "schemas", "provider-result.schema.json"),
    join(runtimeDir, "schemas", "provider-result.schema.json"),
  );
}

function plist({
  accountBinding,
  accountWide,
  agentId,
  capability,
  codexPath,
  logPath,
  nodePath,
  port,
  provider,
  runtimeDir,
  stateDir,
  supportDir,
}) {
  const entryPath = join(runtimeDir, "scripts", "bridge-entry.mjs");
  const launchPath = [
    dirname(nodePath),
    dirname(codexPath),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(":");
  const scrubArguments = SCRUB_BEFORE_NODE.map(
    (name) => `    <string>-u</string>
    <string>${xml(name)}</string>`,
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
    <key>EXTELLA_BRIDGE_AGENT_IDS</key>
    <string>${xml(accountWide ? "" : agentId)}</string>
    <key>EXTELLA_BRIDGE_ACCOUNT_BINDINGS</key>
    <string>${xml(accountWide ? accountBinding : "")}</string>
    <key>EXTELLA_BRIDGE_CAPABILITIES</key>
    <string>${xml(capability)}</string>
    <key>EXTELLA_BRIDGE_ALLOWED_PROVIDERS</key>
    <string>${provider === "codex" ? "mock,codex" : "mock"}</string>
    <key>EXTELLA_BRIDGE_PORT</key>
    <string>${port}</string>
    <key>CODEX_BIN</key>
    <string>${xml(codexPath)}</string>
    <key>PATH</key>
    <string>${xml(launchPath)}</string>
    ${
      provider === "codex"
        ? `<key>EXTELLA_AGENT_BUILDER_LIVE</key>
    <string>I_UNDERSTAND_COST</string>`
        : ""
    }
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
  let consecutiveSuccesses = 0;
  let lastPayload;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        const payload = await response.json();
        if (payload.status === "ok") {
          consecutiveSuccesses += 1;
          lastPayload = payload;
          if (consecutiveSuccesses >= 3) {
            return lastPayload;
          }
        } else {
          consecutiveSuccesses = 0;
          lastError = new Error("Health response did not identify the bridge");
        }
      } else {
        consecutiveSuccesses = 0;
      }
    } catch (error) {
      consecutiveSuccesses = 0;
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(
    `Bridge health check failed${lastError ? `: ${lastError.message}` : ""}`,
  );
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(
      "Usage: configure-bridge-macos.mjs --agent-id <agent_id> " +
        "--capability <hyphen-case-name> [--port 8787] " +
        "[--provider mock]\n" +
        "       Account-wide live mode: --account-wide " +
        "--confirm-account-scope I_UNDERSTAND_ALL_AGENTS " +
        "--capability general-assistance --provider codex " +
        "--confirm-live-cost I_UNDERSTAND_COST\n" +
        "       For approved live mode: --provider codex " +
        "--confirm-live-cost I_UNDERSTAND_COST\n" +
        "       configure-bridge-macos.mjs --disable",
    );
    return;
  }
  if (process.platform !== "darwin") {
    throw new Error("Persistent bridge setup currently supports macOS only");
  }
  const supportDir = join(
    homedir(),
    "Library",
    "Application Support",
    "Extella Agent Builder",
  );
  const runtimeDir = join(supportDir, "runtime");
  const stateDir = join(supportDir, "state");
  const logPath = join(supportDir, "bridge.log");
  const launchAgentsDir = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(launchAgentsDir, `${LABEL}.plist`);
  const domain = `gui/${process.getuid()}`;
  const existingPort = parsed.disable
    ? null
    : await existingConfiguredPort(plistPath);
  const options = validateOptions(
    parsed.port == null && existingPort != null
      ? { ...parsed, port: existingPort }
      : parsed,
  );
  if (options.disable) {
    await launchctl(["bootout", domain, plistPath], { ignoreFailure: true });
    await launchctl(["disable", `${domain}/${LABEL}`]);
    console.log(
      JSON.stringify(
        {
          status: "disabled",
          service: LABEL,
          files_retained: true,
          model_called: false,
        },
        null,
        2,
      ),
    );
    return;
  }
  await launchctl(["bootout", domain, plistPath], { ignoreFailure: true });
  const previousPort = await getLaunchEnvironment("EXTELLA_BRIDGE_PORT");
  const previousAccountBinding = await getLaunchEnvironment(
    "EXTELLA_BRIDGE_ACCOUNT_BINDING",
  );
  let secretState = {
    generated: false,
    previousValue: "",
    value: "",
  };
  let health;
  try {
    await assertPortAvailable(options.port);
    await mkdir(supportDir, { recursive: true, mode: 0o700 });
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await mkdir(launchAgentsDir, { recursive: true });
    await writeRuntime(runtimeDir);
    secretState = await ensureBridgeSecret();
    let accountBinding = "";
    if (options.accountWide) {
      const token = await getLaunchEnvironment("EXTELLA_API_TOKEN");
      accountBinding = deriveAccountBinding(secretState.value, token);
      await launchctl([
        "setenv",
        "EXTELLA_BRIDGE_ACCOUNT_BINDING",
        accountBinding,
      ]);
    }
    await launchctl([
      "setenv",
      "EXTELLA_BRIDGE_PORT",
      String(options.port),
    ]);
    const codexPath = (
      await execFileAsync("/usr/bin/which", ["codex"], { encoding: "utf8" })
    ).stdout.trim();
    if (!codexPath.startsWith("/")) {
      throw new Error("Could not resolve an absolute Codex CLI path");
    }
    await writeFile(
      plistPath,
      plist({
        ...options,
        accountBinding,
        codexPath,
        logPath,
        nodePath: process.execPath,
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
    await launchctl(["disable", `${domain}/${LABEL}`], {
      ignoreFailure: true,
    });
    await restoreLaunchEnvironment("EXTELLA_BRIDGE_PORT", previousPort);
    await restoreLaunchEnvironment(
      "EXTELLA_BRIDGE_ACCOUNT_BINDING",
      previousAccountBinding,
    );
    await restoreLaunchEnvironment(
      "EXTELLA_BRIDGE_SECRET",
      secretState.previousValue,
    );
    throw new Error(
      `Bridge setup failed and was rolled back: ${error.message}`,
    );
  }
  console.log(
    JSON.stringify(
      {
        status: "configured",
        authorization_scope: options.accountWide ? "account" : "agent",
        agent_id: options.accountWide ? null : options.agentId,
        capability: options.capability,
        provider: options.provider,
        model_called: false,
        service: LABEL,
        health,
        restart_required: options.accountWide ? [] : ["Extella Desktop"],
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
    console.error(`configure-bridge-macos: ${error.message}`);
    process.exitCode = 1;
  });
}

export {
  RUNTIME_SCRIPT_FILES,
  SCRUB_BEFORE_NODE,
  assertPortAvailable,
  deriveAccountBinding,
  existingConfiguredPort,
  main,
  parseArgs,
  plist,
  validateOptions,
  waitForHealth,
  writeRuntime,
  xml,
};
