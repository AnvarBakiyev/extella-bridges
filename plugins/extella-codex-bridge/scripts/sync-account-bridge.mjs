#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXPERT_PATH = resolve(
  PLUGIN_DIR,
  "experts",
  "extella_codex_account_bridge_v2.fython",
);
const ADAPTER_PATH = resolve(
  PLUGIN_DIR,
  "integrations",
  "extella-desktop",
  "codex-account-bridge.js",
);
const INSTALLER_PATH = resolve(
  PLUGIN_DIR,
  "integrations",
  "extella-desktop",
  "codex-installer.js",
);

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function javascriptLines(value) {
  return value.split("\n").map((line) => `    ${JSON.stringify(line)}`).join(",\n");
}

function syncInstallerHashes(source) {
  const pairs = [
    ["EXPERT_CODE", "EXPERT_SHA256"],
    ["HEALTH_EXPERT_CODE", "HEALTH_EXPERT_SHA256"],
    ["INSTALL_EXPERT_CODE", "INSTALL_EXPERT_SHA256"],
    ["CREDENTIALS_EXPERT_CODE", "CREDENTIALS_EXPERT_SHA256"],
    ["BRIDGE_EXPERT_CODE", "BRIDGE_EXPERT_SHA256"],
    ["VERIFY_EXPERT_CODE", "VERIFY_EXPERT_SHA256"],
  ];
  let result = source;
  for (const [codeName, hashName] of pairs) {
    const assignmentStart = result.indexOf(`var ${codeName} = [`);
    const joinStart = result.indexOf("].join(", assignmentStart);
    const semicolon = result.indexOf(";", joinStart);
    if (assignmentStart < 0 || joinStart < 0 || semicolon < 0) {
      throw new Error(`Could not locate ${codeName}`);
    }
    const arrayStart = result.indexOf("[", assignmentStart);
    const code = Function(`return ${result.slice(arrayStart, semicolon)}`)();
    result = result.replace(
      new RegExp(`var ${hashName} = '[a-f0-9]{64}'`),
      `var ${hashName} = '${sha256(code)}'`,
    );
  }
  return result;
}

async function main() {
  const expert = (await readFile(EXPERT_PATH, "utf8")).replace(/\r?\n$/, "");
  let adapter = await readFile(ADAPTER_PATH, "utf8");
  adapter = adapter.replace(
    /  var SHA256 = '[a-f0-9]{64}';/,
    `  var SHA256 = '${sha256(expert)}';`,
  );
  adapter = adapter.replace(
    /  var CODE = \[[\s\S]*?\n  \]\.join\('\\n'\);/,
    `  var CODE = [\n${javascriptLines(expert)}\n  ].join('\\n');`,
  );
  adapter = adapter.replace(
    /    description: '[^']*',/,
    "    description: 'Delegate a bounded text task to local Codex under a reviewed execution profile and resume an isolated conversation for the current Extella chat.',",
  );
  if (!adapter.includes("      execution_profile_id: 'answer-only',")) {
    adapter = adapter.replace(
      "      conversation_id: '',\n",
      "      conversation_id: '',\n      execution_profile_id: 'answer-only',\n",
    );
  }
  adapter = adapter.replace(
    /(      execution_profile_id: 'answer-only',\n)(?:\1)+/g,
    "$1",
  );
  await writeFile(ADAPTER_PATH, adapter, "utf8");
  const installer = syncInstallerHashes(
    await readFile(INSTALLER_PATH, "utf8"),
  );
  await writeFile(INSTALLER_PATH, installer, "utf8");
}

main().catch((error) => {
  console.error(`sync-account-bridge: ${error.message}`);
  process.exitCode = 1;
});
