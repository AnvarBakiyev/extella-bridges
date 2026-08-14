#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SENSITIVE_NAME =
  /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSCODE|CREDENTIAL|AUTHORIZATION|COOKIE)/i;
// Each bridge service keeps its own secret under its own name, so the scrub
// has to spare whichever one this service was told to read.
const REQUIRED_SENSITIVE_NAMES = new Set(
  [
    "EXTELLA_BRIDGE_SECRET",
    process.env.EXTELLA_BRIDGE_SECRET_NAME,
  ].filter((name) => /^EXTELLA_[A-Z0-9_]{0,48}BRIDGE_SECRET$/.test(name || "")),
);

function scrubCredentialEnvironment(environment = process.env) {
  const removed = [];
  for (const name of Object.keys(environment)) {
    if (
      SENSITIVE_NAME.test(name) &&
      !REQUIRED_SENSITIVE_NAMES.has(name)
    ) {
      delete environment[name];
      removed.push(name);
    }
  }
  return removed.sort();
}

function isMainModule(metaUrl, argvPath = process.argv[1]) {
  return Boolean(
    argvPath &&
      fileURLToPath(metaUrl) === resolve(argvPath),
  );
}

async function main() {
  scrubCredentialEnvironment();
  const server = await import("./bridge-server.mjs");
  await server.main();
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`bridge-entry: ${error.message}`);
    process.exitCode = 1;
  });
}

export {
  isMainModule,
  main,
  scrubCredentialEnvironment,
};
