# Extella ↔ Claude Code bridge (PoC)

Proof of concept. Nothing here is installed, published, or wired to a live
Extella account. The Codex bridge 0.3.5 is untouched.

## Layout

```
.claude-plugin/marketplace.json          ← repository root, one per repository
plugins/extella-claude-bridge/
  .claude-plugin/plugin.json             ← plugin root, one per plugin
  experts/extella_claude_account_bridge_v1.fython
  scripts/extella-mcp-accounts.mjs
```

The marketplace manifest is not duplicated inside the plugin: a second copy
would become a competing local canon.

## Version pinning

For local validation the marketplace entry uses a relative `source`. At publish
time it becomes a pinned git source, because `claude plugin marketplace add`
has no `--ref` flag — unlike the Codex CLI, pinning lives in the manifest:

```json
{
  "source": "github",
  "owner": "AnvarBakiyev",
  "repo": "extella-codex-bridge",
  "ref": "v0.4.0"
}
```

`ref` accepts a tag, a branch, or a commit SHA. Only a tag is acceptable here:
a branch is a floating source.

## Direction A — one Extella account, one MCP connection

`plugin.json` deliberately declares neither `userConfig` nor `mcpServers`.
A plugin carries exactly one set of `userConfig` values, so a second Extella
account would overwrite the first, which breaks the rule that each account is
its own connection.

Instead each account gets a derived, non-reversible handle and its own entry:

| Derived from the account token | Example |
| --- | --- |
| handle | `acct_9f2c1ab47e05` |
| MCP server name | `extella_acct_9f2c1ab47e05` |
| environment variable | `EXTELLA_MCP_TOKEN_ACCT_9F2C1AB47E05` |

```json
{
  "mcpServers": {
    "extella_acct_9f2c1ab47e05": {
      "type": "http",
      "url": "https://api.extella.ai/mcp/",
      "headers": { "X-Auth-Token": "${EXTELLA_MCP_TOKEN_ACCT_9F2C1AB47E05}" }
    }
  }
}
```

`${VAR}` expansion in `headers` is a documented Claude Code feature, so the
token value never enters the configuration file, git, or a shell history. No
`:-default` is used on purpose: an unset variable must surface as a
missing-variable warning in `claude mcp list` rather than resolve to something
that merely happens to work.

Adding a second account merges by server name, so it cannot disturb the first,
and re-running setup for the same account is idempotent.

**Unclosed:** how the variable is populated. `launchctl setenv NAME VALUE`
places the token in that process's argv, briefly visible in the process table.
The Codex bridge already does this for `EXTELLA_API_TOKEN`, so it is an
inherited property rather than a new one — but it is not the claim
"the token never reaches argv". The intended fix is a `headersHelper` script
reading a `0600` file, which avoids argv entirely. It is not implemented here.

## Direction B — the Expert

`extella_claude_account_bridge_v1.fython` mirrors the Codex Expert: loopback
only, HMAC over `timestamp.nonce.body`, account binding derived from the token,
strict JSON on every return path (H17), `run_agent` never used.

It reads `EXTELLA_CLAUDE_BRIDGE_SECRET` and `EXTELLA_CLAUDE_BRIDGE_PORT` — its
own secret and its own port, not the Codex ones, so an isolation mistake on one
route cannot silently affect the other. The port has no default: an
unconfigured bridge fails visibly instead of talking to whatever is listening.
