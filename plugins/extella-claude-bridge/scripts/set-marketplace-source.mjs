#!/usr/bin/env node
// Switches the marketplace entry between the local path used while proving the
// plugin and the pinned tag used when publishing it.
//
// `claude plugin marketplace add` has no --ref flag, unlike the Codex CLI:
// pinning lives in this manifest. A branch would satisfy the schema and give a
// floating source, so only a tag is accepted here.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MANIFEST = resolve(REPO_ROOT, ".claude-plugin", "marketplace.json");
const PLUGIN_NAME = "extella-claude-bridge";
const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const OWNER = "AnvarBakiyev";
const REPO = "extella-bridges";
const CLONE_URL = `https://github.com/${OWNER}/${REPO}.git`;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--tag" && argv[index + 1]) {
      options.tag = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--local") {
      options.local = true;
    } else if (argv[index] === "--check") {
      options.check = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
    }
  }
  return options;
}

function localSource() {
  return `./plugins/${PLUGIN_NAME}`;
}

function pinnedSource(tag) {
  if (!RELEASE_TAG.test(tag || "")) {
    throw new Error(
      "A published source must pin a release tag such as v0.2.0; " +
        "a branch name is a floating source",
    );
  }
  // The `url` form, not `github`. Measured 21.08.2026 on a machine without an
  // SSH key: the `github` form makes `plugin install` clone over
  // git@github.com and fail with "Permission denied (publickey)" — even when
  // the repository is public. The `url` form clones over HTTPS and still
  // honours the tag: the cache checked out v0.3.6 exactly.
  return { source: "url", url: CLONE_URL, ref: tag };
}

// A string entry is the local path; an object entry must carry a tag. Anything
// else — a branch, a bare repo, a commit-less object — is refused.
function describeSource(entry) {
  if (typeof entry === "string") {
    return entry.startsWith("./")
      ? { kind: "local", pinned: false, detail: entry }
      : { kind: "invalid", pinned: false, detail: entry };
  }
  if (
    entry &&
    entry.source === "url" &&
    entry.url === CLONE_URL &&
    RELEASE_TAG.test(entry.ref || "")
  ) {
    return { kind: "url", pinned: true, detail: entry.ref };
  }
  // The old `github` form is refused on purpose: it pins correctly but installs
  // only for people with an SSH key, which is most of an install failure.
  if (entry && entry.source === "github") {
    return { kind: "invalid", pinned: false, detail: "github form clones over SSH" };
  }
  return { kind: "invalid", pinned: false, detail: JSON.stringify(entry) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  const plugin = manifest.plugins.find((entry) => entry.name === PLUGIN_NAME);
  if (!plugin) throw new Error(`${PLUGIN_NAME} is absent from the marketplace manifest`);

  if (options.check || (!options.tag && !options.local)) {
    const described = describeSource(plugin.source);
    console.log(JSON.stringify({ status: "checked", ...described }, null, 2));
    if (described.kind === "invalid") process.exitCode = 1;
    return;
  }

  plugin.source = options.local ? localSource() : pinnedSource(options.tag);
  await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify({ status: "updated", ...describeSource(plugin.source) }, null, 2),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`set-marketplace-source: ${error.message}`);
    process.exitCode = 1;
  });
}

export { OWNER, PLUGIN_NAME, RELEASE_TAG, REPO, describeSource, localSource, pinnedSource };
