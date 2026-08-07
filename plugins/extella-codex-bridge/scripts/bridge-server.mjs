#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createBridgeServer } from "./bridge-core.mjs";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value === "--port" && next) {
      options.port = Number.parseInt(next, 10);
      index += 1;
    } else if (value === "--workspace" && next) {
      options.workspace = resolve(next);
      index += 1;
    } else if (value === "--state-dir" && next) {
      options.stateDir = resolve(next);
      index += 1;
    } else if (value === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${value}`);
    }
  }
  return options;
}

function integerEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  const value = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function csvEnv(name, fallback = "") {
  return new Set(
    (process.env[name] || fallback)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: bridge-server.mjs [--port 8787] [--workspace <path>] " +
        "[--state-dir <path>]",
    );
    return;
  }
  const host = process.env.EXTELLA_BRIDGE_HOST || "127.0.0.1";
  if (host !== "127.0.0.1") {
    throw new Error("EXTELLA_BRIDGE_HOST must equal 127.0.0.1");
  }
  const port =
    options.port ||
    integerEnv("EXTELLA_BRIDGE_PORT", 8787, 1024, 65535);
  const providers = csvEnv("EXTELLA_BRIDGE_ALLOWED_PROVIDERS", "mock");
  const live =
    providers.has("codex") &&
    process.env.EXTELLA_AGENT_BUILDER_LIVE === "I_UNDERSTAND_COST";
  if (providers.has("codex") && !live) {
    throw new Error(
      "Codex provider requires EXTELLA_AGENT_BUILDER_LIVE=I_UNDERSTAND_COST",
    );
  }
  const server = createBridgeServer({
    secret: process.env.EXTELLA_BRIDGE_SECRET,
    allowedAgentIds: csvEnv("EXTELLA_BRIDGE_AGENT_IDS"),
    allowedAccountBindings: csvEnv(
      "EXTELLA_BRIDGE_ACCOUNT_BINDINGS",
    ),
    allowedCapabilities: csvEnv("EXTELLA_BRIDGE_CAPABILITIES"),
    allowedProviders: providers,
    freshnessSeconds: integerEnv(
      "EXTELLA_BRIDGE_FRESHNESS_SECONDS",
      300,
      30,
      900,
    ),
    maxPromptChars: integerEnv(
      "EXTELLA_AGENT_BUILDER_MAX_PROMPT_CHARS",
      4000,
      1,
      8000,
    ),
    maxOutputTokens: integerEnv(
      "EXTELLA_AGENT_BUILDER_MAX_OUTPUT_TOKENS",
      2000,
      1,
      2000,
    ),
    maxTimeoutMs: integerEnv(
      "EXTELLA_AGENT_BUILDER_TIMEOUT_MS",
      120000,
      1000,
      120000,
    ),
    maxRequestBytes: integerEnv(
      "EXTELLA_BRIDGE_MAX_REQUEST_BYTES",
      64 * 1024,
      1024,
      256 * 1024,
    ),
    workspace: options.workspace || process.cwd(),
    stateDir: options.stateDir,
    live,
  });
  server.listen(port, host, () => {
    console.log(
      JSON.stringify({
        status: "listening",
        host,
        port,
        providers: [...providers],
        live_enabled: live,
      }),
    );
  });
  const stop = () => {
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function isMainModule(metaUrl, argvPath = process.argv[1]) {
  return Boolean(
    argvPath &&
      fileURLToPath(metaUrl) === resolve(argvPath),
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`bridge-server: ${error.message}`);
    process.exitCode = 1;
  });
}

export { csvEnv, isMainModule, main, parseArgs };
