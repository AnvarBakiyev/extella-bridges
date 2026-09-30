---
name: extella-connect
description: Connect Claude Code to an Extella account and prove the connection works. Use when the user asks to connect or set up Extella, when Extella MCP tools are missing or fail, when a call answers "Failed to resolve dependency 'token'", 401 or "Agent required", when an Extella tool returns an empty list and it is unclear whether that is fine, or before any work that builds on Extella.
---

# Connect Claude Code to Extella

Reply to the user in their language. Never ask for the Extella key in the chat, never print
it, never create tokens yourself.

**Connected means one thing only:** an Extella MCP tool was *called from this client* and
answered with account data. Nothing short of that counts.

## Three things that lie (measured, do not re-learn them)

- `claude mcp list` prints **"✓ Connected" with no key and with a wrong key** — MCP
  `initialize` answers HTTP 200 alike in every case. Reachability only.
- A tool call **without `X-Agent-Id`** answers HTTP 200 with `isError` and
  *"Failed to resolve dependency 'token'"* — it blames a key that is fine. A wrong key
  gets the same text.
- The truth: `POST /api/token/validate` says whether the key is valid **and which agent it
  belongs to**; a real `tools/call` proves the MCP channel. An **empty list on a new
  account is a success**, not a failure.

## Which tool proves it (measured — the choice matters)

- **`list_profiles`, no arguments** — rejects a wrong key, answers a valid one in ~600
  characters. Use this one.
- `get_current_profile_and_agent` — answers "successfully" to a **wrong** key: it echoes
  the headers it was sent. **Never a proof.**
- `list_agents` — checks the key, but on a large account answers ~270 000 characters and
  overflows your tool-output limit. And never pass `profile_id: "default"` to it: the
  filter wants a real profile id, "default" answers 404 *Profile not found*.

## Steps

1. **Where are you running?** This must be Claude Code on the user's own computer. A cloud
   session cannot read the user's disk — say so instead of searching for keys.
2. **Run the doctor** (in this skill's directory):
   `python3 scripts/extella_connect.py`
   It lists the keys on the machine (as account handles, never values), validates each with
   `token/validate`, finds every Extella MCP server Claude Code knows, proves each with a
   real `tools/call`, flags two connections to one account, and ends with **one next
   action**. Relay that action; do not invent a different one.
3. **Act on the verdict:**

| doctor says | do |
|---|---|
| no key | the one human action: Extella app → Library → System → Tokens → create a token → save it to `~/.extella/api_token.txt` with mode 600. The user does this, not you, and not via chat. |
| key not recognised | same action, a new token — the old one is dead or from another account |
| key valid, nothing proven | `python3 scripts/extella_connect.py register`, then the user restarts Claude Code |
| two connections to one account | name both, recommend keeping the one stored as `helper` (key in a 0600 file) and removing the other with `claude mcp remove <name> -s user` — **only after the user agrees** |
| proven | after a restart, call that server's `list_profiles` tool yourself, with no arguments — that call is the proof |

4. **After a restart, call `list_profiles`** (no arguments) of the proven server from this
   session. That is the final proof; report it with the server name.

## What `register` does — and does not

One connection per Extella account, the bridge's format exactly: a handle derived from the
key (`acct_<12 hex>`), the key in `~/.extella/mcp/<handle>.token` (0600), a headers helper
`~/.extella/mcp/<handle>.sh` (0700) with the agent id that `token/validate` returned, and a
user-scope server `extella_<handle>` added through `claude mcp add-json`. The key never
enters the config, the command line or the process list. If the account already has its
connection, `register` changes nothing.

It does **not** remove other connections, does not create tokens, and does not run on
native Windows yet (the helper is a shell script — use WSL, macOS or Linux).

## Do not

- trust "Connected", an HTTP 200 or a handshake as proof;
- write your own connector or a second connection for an account that already has one;
- route around a refused action with another tool or shell — name the layer that refused
  and the exact text, and ask for an allowed way;
- treat an empty list on a new account as an error.
