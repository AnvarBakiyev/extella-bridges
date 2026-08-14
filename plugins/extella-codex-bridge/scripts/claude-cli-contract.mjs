// ── CLAUDE CODE CLI CONTRACT ───────────────────────────────────────────────
// The single place in this repository that knows Claude Code CLI flag strings.
// Every flag here was verified against `claude --help` on 2.1.81 and against
// the published reference at https://code.claude.com/docs/en/cli-reference.
//
// PoC co-location note: this module lives beside bridge-core so the macOS
// runtime bundler keeps working unchanged. It is Claude-specific and moves to
// plugins/extella-claude-bridge/scripts once the shared-core refactor is
// approved. Nothing here is imported by the Codex path.

const CLAUDE_POLICY_VERSION = "1.0";

// Isolation is not one flag. Claude Code loads user, project, and local
// setting sources by default, and a `-p` session shows neither the workspace
// trust dialog nor the per-server MCP approval prompt. That means a hook in
// the working directory's .claude/settings.json, or a server in its
// .mcp.json, would execute inside a delegated Extella request. Each entry
// below closes one of those doors; none of them is redundant.
const SESSION_SETTINGS = Object.freeze({
  // Hooks, custom status line, and custom file-suggestion commands.
  disableAllHooks: true,
  // Auto memory must not read or write across delegations.
  autoMemoryEnabled: false,
  // Never silently adopt a project's declared MCP servers.
  enableAllProjectMcpServers: false,
});

const EMPTY_MCP_CONFIG = Object.freeze({ mcpServers: {} });

// The delegated result contract. Kept small on purpose: it is serialized into
// argv, so it must be constant and compact rather than read from a file that
// something else could edit between verification and use.
const RESULT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "provider", "event_id", "status", "answer"],
  properties: {
    schema_version: { const: "1.0" },
    provider: { const: "claude" },
    event_id: { type: "string", minLength: 8, maxLength: 128 },
    status: { const: "completed" },
    answer: { type: "string" },
  },
});

// Belt and suspenders behind `--tools ""`. If a future release changes how an
// empty tool set is interpreted, these names still have to be denied.
const DENIED_TOOLS = Object.freeze([
  "Agent",
  "Bash",
  "Edit",
  "NotebookEdit",
  "Task",
  "WebFetch",
  "WebSearch",
  "Write",
]);

const MANAGED_SETTINGS_PATHS = Object.freeze({
  darwin: "/Library/Application Support/ClaudeCode",
  linux: "/etc/claude-code",
  win32: "C:\\Program Files\\ClaudeCode",
});

// Environment allowlist. The Codex adapter uses a denylist regex; that is the
// wrong shape here, because "no variable matched SECRET" does not prove that
// nothing sensitive was inherited. Anything absent from this list is dropped.
const ENVIRONMENT_ALLOWLIST = Object.freeze([
  "CLAUDE_CONFIG_DIR",
  "HOME",
  "LANG",
  "LOGNAME",
  "PATH",
  "SHELL",
  "SSL_CERT_FILE",
  "TMPDIR",
  "USER",
]);

const ENVIRONMENT_ALLOWLIST_PREFIXES = Object.freeze(["LC_"]);

// Forced values. TERM=dumb and NO_COLOR keep control sequences out of the
// captured output; the memory switch is the environment-level twin of
// autoMemoryEnabled, because a managed setting could re-enable the latter.
const ENVIRONMENT_FORCED = Object.freeze({
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  NO_COLOR: "1",
  TERM: "dumb",
});

function claudeBinary(environment = process.env) {
  return environment.CLAUDE_BIN || "claude";
}

function compactJson(value) {
  return JSON.stringify(value);
}

// `claude auth status` defaults to JSON. The response also carries email,
// orgId, and orgName, so only the boolean and the coarse plan label may ever
// leave this function.
function claudeAuthStatusArguments() {
  return ["auth", "status", "--json"];
}

function claudeVersionArguments() {
  return ["--version"];
}

function baseDelegationArguments() {
  return [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    compactJson(RESULT_SCHEMA),
    // Empty set: user, project, and local settings are all skipped. Verified
    // empirically — `claude --setting-sources "" mcp list` reports no servers
    // while `--setting-sources "user"` lists the user's own.
    "--setting-sources",
    "",
    "--settings",
    compactJson(SESSION_SETTINGS),
    "--strict-mcp-config",
    "--mcp-config",
    compactJson(EMPTY_MCP_CONFIG),
    "--tools",
    "",
    "--disallowed-tools",
    DENIED_TOOLS.join(","),
    "--permission-mode",
    "dontAsk",
    "--disable-slash-commands",
    "--max-turns",
    "1",
  ];
}

function claudeDelegationArguments({ sessionId = null } = {}) {
  const args = baseDelegationArguments();
  if (sessionId !== null) {
    if (!isSessionId(sessionId)) {
      throw new Error("A valid Claude session ID is required");
    }
    // --resume, never --continue: --continue picks the most recent
    // conversation in the current directory, which is another chat's session.
    args.push("--resume", sessionId);
  }
  return args;
}

const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isSessionId(value) {
  return SESSION_ID.test(value || "");
}

export {
  CLAUDE_POLICY_VERSION,
  DENIED_TOOLS,
  EMPTY_MCP_CONFIG,
  ENVIRONMENT_ALLOWLIST,
  ENVIRONMENT_ALLOWLIST_PREFIXES,
  ENVIRONMENT_FORCED,
  MANAGED_SETTINGS_PATHS,
  RESULT_SCHEMA,
  SESSION_ID,
  SESSION_SETTINGS,
  claudeAuthStatusArguments,
  claudeBinary,
  claudeDelegationArguments,
  claudeVersionArguments,
  isSessionId,
};
