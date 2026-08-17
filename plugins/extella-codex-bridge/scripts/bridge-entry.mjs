#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SENSITIVE_NAME =
  /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSCODE|CREDENTIAL|AUTHORIZATION|COOKIE)/i;
// Each bridge service keeps its own secret under its own name, so the scrub
// has to spare whichever one this service was told to read — and the pointer
// that names it.
//
// The pointer is the subtle part. EXTELLA_BRIDGE_SECRET_NAME holds a variable
// name, not a credential, but it matches the SECRET pattern and was being
// removed with everything else. The server then fell back to the default
// variable, which the LaunchAgent had deliberately unset, and the service died
// at startup with a message naming a variable nobody had configured. Measured
// on the first live install attempt, 2026-08-14.
const SECRET_POINTER = "EXTELLA_BRIDGE_SECRET_NAME";
const SECRET_VARIABLE = /^EXTELLA_[A-Z0-9_]{0,48}BRIDGE_SECRET$/;

function requiredSensitiveNames(environment = process.env) {
  const pointed = environment[SECRET_POINTER];
  return new Set(
    [
      "EXTELLA_BRIDGE_SECRET",
      SECRET_POINTER,
      SECRET_VARIABLE.test(pointed || "") ? pointed : null,
    ].filter(Boolean),
  );
}

function scrubCredentialEnvironment(environment = process.env) {
  // Resolved from the environment being scrubbed, not from process.env at
  // import time: the two are the same for the service and differ in tests.
  const required = requiredSensitiveNames(environment);
  const removed = [];
  for (const name of Object.keys(environment)) {
    if (SENSITIVE_NAME.test(name) && !required.has(name)) {
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
