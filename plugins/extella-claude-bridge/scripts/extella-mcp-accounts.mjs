// ── PER-ACCOUNT EXTELLA MCP CONNECTIONS ────────────────────────────────────
// Direction A (Claude Code → Extella). One Extella account is one MCP server
// entry with its own environment variable. This module derives names only; it
// performs no writes and touches no live configuration.
//
// Why not plugin userConfig: a plugin carries exactly one set of userConfig
// values, so a second account would overwrite the first. That makes it the
// wrong primary store for a rule that says "each account is its own
// connection". userConfig stays available for a single-account convenience
// path, but it is not the contract below.

import { createHash } from "node:crypto";

const ACCOUNT_HANDLE = /^acct_[a-f0-9]{12}$/;
const SERVER_NAME = /^extella_acct_[a-f0-9]{12}$/;
const ENVIRONMENT_NAME = /^EXTELLA_MCP_TOKEN_ACCT_[A-F0-9]{12}$/;

const EXTELLA_MCP_URL = "https://api.extella.ai/mcp/";

// A stable, non-reversible handle. Twelve hex characters of a domain-separated
// digest: enough to keep two accounts apart on one machine, short enough to
// read in a config file, and useless to anyone who obtains it.
function accountHandle(token) {
  if (typeof token !== "string" || token.trim().length < 8) {
    throw new Error("An Extella account token is required to derive a handle");
  }
  const digest = createHash("sha256")
    .update(`extella-mcp-account-v1.${token.trim()}`, "utf8")
    .digest("hex");
  return `acct_${digest.slice(0, 12)}`;
}

function serverName(handle) {
  if (!ACCOUNT_HANDLE.test(handle || "")) {
    throw new Error("A valid Extella account handle is required");
  }
  return `extella_${handle}`;
}

function environmentName(handle) {
  if (!ACCOUNT_HANDLE.test(handle || "")) {
    throw new Error("A valid Extella account handle is required");
  }
  return `EXTELLA_MCP_TOKEN_${handle.toUpperCase()}`;
}

// The MCP entry. `${VAR}` expansion in `headers` is a documented Claude Code
// feature, so the token value never appears in the configuration file, in git,
// or in a shell history. The default is deliberately absent: an unset variable
// must surface as a missing-variable warning in `claude mcp list`, not silently
// fall back to something that happens to work.
function mcpServerEntry(handle) {
  const variable = environmentName(handle);
  return {
    type: "http",
    url: EXTELLA_MCP_URL,
    headers: {
      "X-Auth-Token": `\${${variable}}`,
    },
  };
}

function mcpConfigFragment(handle) {
  return { mcpServers: { [serverName(handle)]: mcpServerEntry(handle) } };
}

// Adding a second account must not disturb the first. Merge is by server name,
// which is derived from the account, so two accounts can never contend for one
// entry and a repeated setup for the same account is idempotent.
function mergeAccountConfig(existing, handle) {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? existing
      : {};
  const servers =
    base.mcpServers && typeof base.mcpServers === "object" ? base.mcpServers : {};
  return {
    ...base,
    mcpServers: { ...servers, [serverName(handle)]: mcpServerEntry(handle) },
  };
}

// Serialized form must never contain a token. Tests assert this against a
// known token value rather than trusting the shape by inspection.
function containsTokenMaterial(serialized, token) {
  return typeof token === "string" && token.length >= 8
    ? String(serialized).includes(token)
    : false;
}

export {
  ACCOUNT_HANDLE,
  ENVIRONMENT_NAME,
  EXTELLA_MCP_URL,
  SERVER_NAME,
  accountHandle,
  containsTokenMaterial,
  environmentName,
  mcpConfigFragment,
  mcpServerEntry,
  mergeAccountConfig,
  serverName,
};
