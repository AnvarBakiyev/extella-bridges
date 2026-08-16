#!/usr/bin/env node
// Embeds the two Experts into the desktop adapters and pins their digests.
//
// The Codex repository learned this the hard way: an Expert that lives in one
// place and is shipped from another drifts, and the drift is invisible until a
// customer runs the older copy. The source of truth is the file on disk; the
// adapters carry a generated copy plus its SHA-256, and the test suite fails
// if the two disagree.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SETUP_EXPERT = resolve(PLUGIN_DIR, "experts", "extella_claude_product_setup.py");
const BRIDGE_EXPERT = resolve(
  PLUGIN_DIR, "experts", "extella_claude_account_bridge_v1.fython",
);
const INSTALLER = resolve(
  PLUGIN_DIR, "integrations", "extella-desktop", "claude-installer.js",
);
const ACCOUNT_BRIDGE = resolve(
  PLUGIN_DIR, "integrations", "extella-desktop", "claude-account-bridge.js",
);

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function javascriptLines(value) {
  return value
    .split("\n")
    .map((line) => `    ${JSON.stringify(line)}`)
    .join(",\n");
}

function replaceArray(source, name, code) {
  const assignment = new RegExp(
    `(  var ${name} = )(?:'__EXPERT_CODE__'|\\[[\\s\\S]*?\\n  \\]\\.join\\('\\\\n'\\));`,
  );
  if (!assignment.test(source)) {
    throw new Error(`Could not locate ${name} in the adapter`);
  }
  return source.replace(
    assignment,
    `$1[\n${javascriptLines(code)}\n  ].join('\\n');`,
  );
}

function replaceHash(source, name, digest) {
  const assignment = new RegExp(`(  var ${name} = ')(?:__EXPERT_SHA256__|[a-f0-9]{64})(';)`);
  if (!assignment.test(source)) {
    throw new Error(`Could not locate ${name} in the adapter`);
  }
  return source.replace(assignment, `$1${digest}$2`);
}

async function main() {
  const setup = (await readFile(SETUP_EXPERT, "utf8")).replace(/\r?\n$/, "");
  let installer = await readFile(INSTALLER, "utf8");
  installer = replaceArray(installer, "EXPERT_CODE", setup);
  installer = replaceHash(installer, "EXPERT_SHA256", sha256(setup));
  await writeFile(INSTALLER, installer, "utf8");

  const bridge = (await readFile(BRIDGE_EXPERT, "utf8")).replace(/\r?\n$/, "");
  let adapter = await readFile(ACCOUNT_BRIDGE, "utf8");
  adapter = replaceArray(adapter, "CODE", bridge);
  adapter = replaceHash(adapter, "SHA256", sha256(bridge));
  await writeFile(ACCOUNT_BRIDGE, adapter, "utf8");

  console.log(
    JSON.stringify(
      {
        status: "synced",
        setup_expert_sha256: sha256(setup),
        bridge_expert_sha256: sha256(bridge),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(`sync-claude-assets: ${error.message}`);
  process.exitCode = 1;
});
