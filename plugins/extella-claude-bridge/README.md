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

Proven live on 2026-08-14: a real `list_agents` call returned account data
through this configuration.

`plugin.json` deliberately declares neither `userConfig` nor `mcpServers`.
A plugin carries exactly one set of `userConfig` values, so a second Extella
account would overwrite the first, which breaks the rule that each account is
its own connection.

Each account gets a derived, non-reversible handle and its own entry:

| Derived from the account token | Example |
| --- | --- |
| handle | `acct_9f2c1ab47e05` |
| MCP server name | `extella_acct_9f2c1ab47e05` |
| token file, mode 0600 | `~/.extella/mcp/acct_9f2c1ab47e05.token` |
| headers helper, mode 0700 | `~/.extella/mcp/acct_9f2c1ab47e05.sh` |

```json
{
  "mcpServers": {
    "extella_acct_9f2c1ab47e05": {
      "type": "http",
      "url": "https://api.extella.ai/mcp/",
      "headersHelper": "/Users/you/.extella/mcp/acct_9f2c1ab47e05.sh"
    }
  }
}
```

### Why headersHelper and not `${VAR}`

Both keep the token out of the config file and out of git. `${VAR}` was
measured and rejected for two further reasons:

* it puts the token in the process environment;
* **`claude mcp get` prints the resolved header value in plain text.** With a
  helper that command has nothing to print — the measured output shows no
  `Headers` block at all.

The helper reads the token from its 0600 file at request time and never
receives it as an argument, so it appears in no process listing.

### Three headers, and an agent id that belongs to the token

A connection carrying only `X-Auth-Token` fails every tool call with a
dependency resolution error for `token`. Extella needs the same trio that
`deploy-extella-assets.mjs` already sends on every REST call:

```
X-Auth-Token   from the 0600 file
X-Profile-Id   default
X-Agent-Id     resolved per token, NOT the literal agent_extella_default
```

`POST /api/token/validate` returns `agent_id` for the token; it is resolved
once at setup and written into the helper.

### Verification must not trust "Connected"

`claude mcp list` and `claude mcp get` report `✓ Connected` for a server with
no token at all, and for a deliberately wrong one. Measured: an MCP
`initialize` returns an identical HTTP 200 in all three cases, so the health
check proves reachability and nothing else.

Account binding is verified against `POST /api/token/validate`, which the Codex
installer already uses, calls no model, and yields the agent id the headers
need.

## Direction B — the Expert

`extella_claude_account_bridge_v1.fython` mirrors the Codex Expert: loopback
only, HMAC over `timestamp.nonce.body`, account binding derived from the token,
strict JSON on every return path (H17), `run_agent` never used.

It reads `EXTELLA_CLAUDE_BRIDGE_SECRET` and `EXTELLA_CLAUDE_BRIDGE_PORT` — its
own secret and its own port, not the Codex ones, so an isolation mistake on one
route cannot silently affect the other. The port has no default: an
unconfigured bridge fails visibly instead of talking to whatever is listening.
