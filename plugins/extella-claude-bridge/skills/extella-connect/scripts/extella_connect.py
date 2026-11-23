#!/usr/bin/env python3
"""Check and register the Extella MCP connection for Claude Code.

    python3 extella_connect.py            # doctor: what is connected, proven how
    python3 extella_connect.py --json     # the same, machine-readable
    python3 extella_connect.py register   # connect this machine's Extella account
    python3 extella_connect.py register --agent agent_…  # connect one more agent of it
    python3 extella_connect.py --selftest # offline checks, no network

WHY A SCRIPT. Three things lie about an Extella connection, all measured:
  * `claude mcp list` prints "✓ Connected" with no key and with a wrong key —
    MCP `initialize` answers HTTP 200 alike in all three cases;
  * a tool call without X-Agent-Id answers HTTP 200 with isError and
    "Failed to resolve dependency 'token'", blaming a key that is fine;
  * the same text comes back for a wrong key.
The truth comes from two places: `POST /api/token/validate` (is the key valid,
and which agent it belongs to) and a real MCP `tools/call` with the headers the
client will send.

SAME FORMAT AS THE BRIDGE. `register` writes exactly what
scripts/extella-mcp-accounts.mjs describes — one connection per account, a
derived handle, a 0600 token file, a 0700 headers helper, the server entry with
an absolute helper path. A parity test in the Codex plugin's suite compares the
two implementations, so they cannot drift apart silently.

Nothing here prints a key. Standard library only.
"""
import hashlib
import json
import os
import pathlib
import re
import shutil
import ssl
import subprocess
import sys
import urllib.error
import urllib.request

MCP_URL = "https://api.extella.ai/mcp/"
AGENT_LIST_URL = "https://api.extella.ai/api/agent/list"
VALIDATE_URL = "https://api.extella.ai/api/token/validate"
PROFILE = "default"
HANDLE_RE = re.compile(r"^acct_[a-f0-9]{12}$")
AGENT_RE = re.compile(r"^agent_[A-Za-z0-9_-]{8,128}$")
NO_KEY = ("No Extella key on this computer. One human action: in the Extella app open "
          "Library → System → Tokens, create a token and save it to "
          "~/.extella/api_token.txt with mode 600. Never paste the key into a chat.")


def home() -> pathlib.Path:
    return pathlib.Path(os.environ.get("HOME") or pathlib.Path.home())


# Python from python.org on a Mac ships without root certificates until its
# «Install Certificates.command» is run: every https call then fails with
# CERTIFICATE_VERIFY_FAILED (live case 27.10.2026). Verification is never turned
# off; when Python has no bundle of its own, the macOS system bundle is used.
SYSTEM_BUNDLES = ("/etc/ssl/cert.pem", "/private/etc/ssl/cert.pem")


def tls_context(factory=None, bundles=SYSTEM_BUNDLES):
    ctx = (factory or ssl.create_default_context)()
    try:
        if ctx.cert_store_stats().get("x509_ca", 0) > 0:
            return ctx
    except Exception:                                            # noqa: BLE001
        return ctx
    for path in bundles:
        if os.path.isfile(path):
            try:
                ctx.load_verify_locations(cafile=path)
            except Exception:                                    # noqa: BLE001
                continue
            if ctx.cert_store_stats().get("x509_ca", 0) > 0:
                break
    return ctx


def network_reason(error) -> str:
    text = str(error)
    if "CERTIFICATE_VERIFY_FAILED" in text:
        return ("Python here cannot verify Extella's certificate (CERTIFICATE_VERIFY_FAILED): "
                "it has no root certificates. With python.org Python on a Mac, run "
                "«Install Certificates.command» from Applications/Python 3.x once.")
    return f"no answer ({type(error).__name__})"


# ── the bridge's format ────────────────────────────────────────────────────
def account_handle(token: str) -> str:
    digest = hashlib.sha256(f"extella-mcp-account-v1.{token.strip()}".encode("utf-8"))
    return "acct_" + digest.hexdigest()[:12]


def agent_suffix(agent_id: str) -> str:
    """8 hex of sha256(agent_id): names one agent's binding inside an account."""
    if not AGENT_RE.fullmatch(agent_id or ""):
        raise ValueError("A valid Extella agent id is required")
    return hashlib.sha256(agent_id.encode("utf-8")).hexdigest()[:8]


def binding_name(handle: str, agent_id: str = "") -> str:
    """`acct_<12>` for the account's main agent, `acct_<12>_<8>` for a chosen one."""
    assert HANDLE_RE.match(handle), "invalid handle"
    return f"{handle}_{agent_suffix(agent_id)}" if agent_id else handle


def server_name(handle: str, agent_id: str = "") -> str:
    return f"extella_{binding_name(handle, agent_id)}"


def token_file(handle: str, h: pathlib.Path) -> pathlib.Path:
    return h / ".extella" / "mcp" / f"{handle}.token"


def helper_file(handle: str, h: pathlib.Path, agent_id: str = "") -> pathlib.Path:
    return h / ".extella" / "mcp" / f"{binding_name(handle, agent_id)}.sh"


def helper_script(handle: str, agent_id: str, h: pathlib.Path) -> str:
    """Byte-for-byte what headersHelperScript() in the Node library produces."""
    if not AGENT_RE.fullmatch(agent_id or ""):
        raise ValueError("A resolved Extella agent id is required")
    return "\n".join([
        "#!/bin/sh",
        "# Generated by the Extella Claude bridge. Reads a 0600 token file.",
        "printf '{\"X-Auth-Token\":\"%s\",\"X-Profile-Id\":\"" + PROFILE +
        "\",\"X-Agent-Id\":\"" + agent_id + "\"}\\n' \\",
        f"  \"$(cat \"{token_file(handle, h)}\")\"",
        "",
    ])


def server_entry(helper_path: str) -> dict:
    return {"type": "http", "url": MCP_URL, "headersHelper": helper_path}


# ── native Windows ─────────────────────────────────────────────────────────
# Claude Code runs a headersHelper "in a shell": on Windows that is Git Bash, or
# PowerShell when Git for Windows is absent (code.claude.com/docs/en/hooks, the same
# rule for shell-form commands). One command string has to work in both, so it is
# an UNQUOTED absolute path with forward slashes and no spaces: bash would eat
# backslashes, PowerShell does not execute a quoted string. A path with spaces
# ("C:/Users/Ivan Petrov/...") is replaced by its 8.3 short form. The helper is a
# .cmd file: both shells run it, and it needs neither Python nor a POSIX shell.
WIN_TOKEN_RE = re.compile(r"^[A-Za-z0-9._~+/=-]{8,512}$")


def is_windows() -> bool:
    return sys.platform.startswith("win")


def helper_file_windows(handle: str, h: pathlib.Path, agent_id: str = "") -> pathlib.Path:
    return h / ".extella" / "mcp" / f"{binding_name(handle, agent_id)}.cmd"


def helper_script_windows(handle: str, agent_id: str) -> str:
    """A .cmd that reads the account's token file and prints the headers JSON.
    The key is not inside. The token file is named relative to the helper itself
    (%~dp0), so a Cyrillic profile name never has to be encoded into the .cmd."""
    assert HANDLE_RE.match(handle), "invalid handle"
    if not AGENT_RE.fullmatch(agent_id or ""):
        raise ValueError("A resolved Extella agent id is required")
    return "\r\n".join([
        "@echo off",
        "rem Generated by the Extella Claude bridge. Reads the account's token file.",
        "setlocal",
        f'set /p EXTELLA_T=<"%~dp0{handle}.token"',
        'echo {"X-Auth-Token":"%EXTELLA_T%","X-Profile-Id":"' + PROFILE +
        '","X-Agent-Id":"' + agent_id + '"}',
        "",
    ])


def short_path(path: str) -> str:
    """8.3 form of an existing path (no spaces), or the path itself off Windows."""
    if not is_windows():
        return path
    import ctypes
    buf = ctypes.create_unicode_buffer(1024)
    n = ctypes.windll.kernel32.GetShortPathNameW(str(path), buf, 1024)
    return buf.value if 0 < n < 1024 else path


def helper_command_windows(path: str) -> str:
    """The headersHelper string: runs in Git Bash and in PowerShell alike."""
    command = short_path(path).replace("\\", "/")
    if " " in command or not re.match(r"^[A-Za-z]:/", command):
        raise ValueError("the helper path has spaces and no 8.3 short name; "
                         "it cannot run in both Git Bash and PowerShell")
    return command


def run_helper(helper: str) -> subprocess.CompletedProcess:
    """Run a registered helper the way this OS can: a .cmd goes through cmd.exe."""
    if is_windows():
        return subprocess.run(["cmd.exe", "/d", "/c", helper.replace("/", "\\")],
                              capture_output=True, text=True, timeout=30)
    return subprocess.run([helper], capture_output=True, text=True, timeout=30)


def claude_command() -> list:
    """`claude` as an argv head. On Windows a list call does not find claude.cmd by
    name, so the full path from PATH is used."""
    found = shutil.which("claude")
    return [found] if found else []


# ── keys and servers on this machine ───────────────────────────────────────
def keys_on_disk() -> list[tuple[str, str]]:
    """(where, value) for every distinct key the machine holds. Value never printed."""
    h, found, seen = home(), [], set()

    def add(where, value):
        value = (value or "").strip()
        if len(value) >= 8 and value not in seen:
            seen.add(value)
            found.append((where, value))

    add("EXTELLA_API_TOKEN", os.environ.get("EXTELLA_API_TOKEN"))
    for name in ("api_token.txt", "os_token.txt"):
        try:
            add(f"~/.extella/{name}", (h / ".extella" / name).read_text(encoding="utf-8"))
        except OSError:
            pass
    for f in sorted((h / ".extella" / "mcp").glob("acct_*.token")):
        try:
            add(f"~/.extella/mcp/{f.name}", f.read_text(encoding="utf-8"))
        except OSError:
            pass
    return found


def extella_servers() -> list[dict]:
    """Every Extella MCP server Claude Code knows, user and project scope."""
    try:
        cfg = json.loads((home() / ".claude.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    scopes = [("user", cfg.get("mcpServers") or {})]
    for path, project in (cfg.get("projects") or {}).items():
        scopes.append((f"project {path}", (project or {}).get("mcpServers") or {}))
    out = []
    for scope, servers in scopes:
        for name, entry in servers.items():
            if isinstance(entry, dict) and "api.extella.ai/mcp" in str(entry.get("url", "")):
                out.append({"name": name, "scope": scope, "entry": entry})
    return out


def server_headers(entry: dict) -> tuple[dict, str]:
    """Headers the client would send, and how they are stored."""
    helper = entry.get("headersHelper")
    if helper:
        if is_windows() and not str(helper).lower().endswith((".cmd", ".bat")):
            return {}, "helper is a shell script — cannot run on native Windows"
        try:
            done = run_helper(helper)
            return json.loads(done.stdout or "{}"), "helper"
        except (OSError, ValueError, subprocess.TimeoutExpired) as e:
            return {}, f"helper failed: {type(e).__name__}"
    return dict(entry.get("headers") or {}), "static headers in ~/.claude.json"


# ── proofs ─────────────────────────────────────────────────────────────────
def validate(token: str) -> dict:
    body = json.dumps({"token": token}).encode()
    req = urllib.request.Request(VALIDATE_URL, data=body, method="POST", headers={
        "Content-Type": "application/json", "X-Auth-Token": token, "X-Profile-Id": PROFILE})
    try:
        with urllib.request.urlopen(req, timeout=40, context=tls_context()) as r:
            data = json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        return {"valid": False, "why": f"HTTP {e.code}"}
    except Exception as e:                                       # noqa: BLE001
        return {"valid": None, "why": network_reason(e)}
    return {"valid": bool(data.get("valid")), "agent_id": data.get("agent_id"),
            "why": "" if data.get("valid") else "token/validate: valid=false"}


def _mcp(body: dict, headers: dict, session: str = ""):
    h = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    h.update(headers)
    if session:
        h["Mcp-Session-Id"] = session
    req = urllib.request.Request(MCP_URL, data=json.dumps(body).encode(), method="POST", headers=h)
    with urllib.request.urlopen(req, timeout=60, context=tls_context()) as r:
        return r.read(600_000).decode("utf-8", "replace"), r.headers.get("Mcp-Session-Id") or ""


def _last_json(text: str):
    last = None
    for line in text.splitlines():
        line = line.strip()
        line = line[5:].strip() if line.startswith("data:") else line
        if line.startswith("{"):
            try:
                last = json.loads(line)
            except ValueError:
                pass
    return last


# The proof tool. Chosen by measurement (30.09.2026), not by habit:
#   * list_profiles — rejects a wrong key (isError, "dependency 'token'") and answers a
#     valid one in ~600 characters: a real proof that fits any client's output limit;
#   * list_agents — also checks the key, but on a large account answers ~270 000
#     characters: it overflows the client's tool-output limit and, read partially,
#     cannot be parsed — which an absence-of-error check would call a success;
#   * get_current_profile_and_agent — answers "successfully" to a WRONG key: it echoes
#     the headers it was sent. Never a proof.
PROOF_TOOL = "list_profiles"


def prove_tool_call(headers: dict) -> tuple[bool, str]:
    """A real tools/call — the only thing that proves the MCP channel. Proven means a
    PARSED answer that says isError=false and carries content; anything else is not."""
    if not headers.get("X-Auth-Token"):
        return False, "no key in the headers"
    if not str(headers.get("X-Agent-Id", "")).strip():
        return False, "no X-Agent-Id: every tool call will fail and blame the key"
    try:
        _, sess = _mcp({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "extella-connect", "version": "1"}}}, headers)
        text, _ = _mcp({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                        "params": {"name": PROOF_TOOL, "arguments": {}}}, headers, sess)
    except Exception as e:                                       # noqa: BLE001
        return False, "MCP did not answer: " + network_reason(e)
    return judge(_last_json(text))


def judge(answer) -> tuple[bool, str]:
    """Positive evidence only. An unparsed or empty answer is NOT a success."""
    if not isinstance(answer, dict):
        return False, "the tool answer could not be parsed — not proven"
    if "error" in answer:
        return False, "MCP refused the tool call"
    result = answer.get("result")
    if not isinstance(result, dict):
        return False, "no result in the tool answer — not proven"
    if result.get("isError") is not False:
        return False, "MCP refused the tool call"
    content = result.get("content") or []
    if not content or not str(content[0].get("text", "")).strip():
        return False, "the tool answered with nothing — not proven"
    return True, f"{PROOF_TOOL} answered with account data"


# ── doctor and register ────────────────────────────────────────────────────
def doctor() -> dict:
    report = {"accounts": [], "servers": [], "duplicates": [], "next_action": ""}
    keys = keys_on_disk()
    by_handle = {}
    for where, token in keys:
        v = validate(token)
        handle = account_handle(token)
        by_handle.setdefault(handle, {"handle": handle, "found_in": [], **v})
        by_handle[handle]["found_in"].append(where)
    report["accounts"] = list(by_handle.values())

    for s in extella_servers():
        headers, stored = server_headers(s["entry"])
        token = str(headers.get("X-Auth-Token", ""))
        row = {"name": s["name"], "scope": s["scope"], "stored": stored,
               "account": account_handle(token) if token else None,
               "agent_header": bool(str(headers.get("X-Agent-Id", "")).strip()),
               "agent_id": str(headers.get("X-Agent-Id", "")).strip() or None}
        row["proven"], row["proof"] = prove_tool_call(headers)
        if not row["proven"] and token:
            v = validate(token)
            row["cause"] = ("key not recognised — create a new token" if v.get("valid") is False
                            else "key is VALID — fix the MCP headers, not the token")
        report["servers"].append(row)

    # Several agents of one account are several bindings, not duplicates. A duplicate
    # is two connections that send the same key AND the same agent.
    seen = {}
    for row in report["servers"]:
        if row["account"]:
            seen.setdefault((row["account"], row["agent_id"]), []).append(row["name"])
            acct = by_handle.get(row["account"])
            if acct is not None:
                acct.setdefault("bindings", []).append(
                    {"server": row["name"], "agent_id": row["agent_id"], "proven": row["proven"]})
    for acct in report["accounts"]:
        acct.setdefault("bindings", [])
    report["duplicates"] = [{"account": a, "agent_id": g, "servers": n}
                            for (a, g), n in seen.items() if len(n) > 1]

    valid = [a for a in report["accounts"] if a.get("valid")]
    proven = [r for r in report["servers"] if r["proven"]]
    if not keys:
        report["next_action"] = NO_KEY
    elif not valid:
        report["next_action"] = ("The key on this computer is not recognised by Extella. "
                                 "Library → System → Tokens: create a new one, save it to "
                                 "~/.extella/api_token.txt (mode 600).")
    elif report["duplicates"]:
        d = report["duplicates"][0]
        report["next_action"] = (f"Two connections to ONE account ({', '.join(d['servers'])}). "
                                 "Keep the one whose key lives in a 0600 file (stored: helper); "
                                 "remove the other with `claude mcp remove <name> -s user` — "
                                 "only after the user agrees.")
    elif not proven:
        report["next_action"] = ("The key is valid, but no connection proves itself. "
                                 "Run `python3 extella_connect.py register`, then restart Claude Code.")
    else:
        report["next_action"] = (f"Connected and proven: {proven[0]['name']}. After a restart, call its "
                                 f"{PROOF_TOOL} tool (no arguments) from this session — that "
                                 "call is the final proof.")
    return report


def connections_of(handle: str, agent_id: str = "", main_agent: str = "") -> list[str]:
    """Names of every Extella server that sends THIS account's key, whatever its name.

    With `agent_id` (a chosen agent) only connections of that agent count. Without it
    (the account's main agent) every connection of the account counts EXCEPT those
    that send another agent, so one more agent never blocks the main connection and
    the main connection never blocks one more agent."""
    names = []
    for srv in extella_servers():
        headers, _ = server_headers(srv["entry"])
        sent = str(headers.get("X-Auth-Token", ""))
        sent_agent = str(headers.get("X-Agent-Id", "")).strip()
        mine = sent and account_handle(sent) == handle
        if agent_id:
            if srv["name"] == server_name(handle, agent_id) or (mine and sent_agent == agent_id):
                names.append(srv["name"])
        elif srv["name"] == server_name(handle) or (
                mine and (not sent_agent or not main_agent or sent_agent == main_agent)):
            names.append(srv["name"])
    return names


def account_agents(token: str, main_agent: str):
    """Agent ids of the key's account by REST, or None when the list cannot be read.

    Why besides the proof call: MCP accepted a NONEXISTENT X-Agent-Id on list_agents
    (measured 28.09.2026), so a proof call alone may not catch a foreign agent. The
    list answers only for this key's account; read-only, ids only, nothing printed."""
    req = urllib.request.Request(AGENT_LIST_URL, data=b"{}", method="POST", headers={
        "Content-Type": "application/json", "X-Auth-Token": token,
        "X-Profile-Id": PROFILE, "X-Agent-Id": main_agent})
    try:
        with urllib.request.urlopen(req, timeout=60, context=tls_context()) as r:
            data = json.loads(r.read(20_000_000).decode("utf-8", "replace"))
    except Exception:                                            # noqa: BLE001
        return None
    rows = data.get("agents") if isinstance(data, dict) else data
    if not isinstance(rows, list):
        return None
    return {str(a.get("id")) for a in rows if isinstance(a, dict) and a.get("id")}


def headers_for(token: str, agent_id: str) -> dict:
    return {"X-Auth-Token": token, "X-Profile-Id": PROFILE, "X-Agent-Id": agent_id}


def register(chosen: str = "") -> dict:
    """Connect the account's main agent, or with `chosen` one more agent of it."""
    if chosen and not AGENT_RE.fullmatch(chosen):
        return {"status": "error", "message": "The agent id has a wrong shape: expected "
                "agent_ followed by 8–128 letters, digits, «_» or «-». Nothing was changed."}
    keys = keys_on_disk()
    if not keys:
        return {"status": "error", "message": NO_KEY}
    where, token = keys[0]
    v = validate(token)
    if not v.get("valid"):
        return {"status": "error", "message": f"Key from {where} is not valid ({v.get('why')})."}
    agent = str(v.get("agent_id") or "")
    if not AGENT_RE.fullmatch(agent):
        return {"status": "error", "message": "token/validate returned no usable agent id."}
    handle, h = account_handle(token), home()
    # The token's own agent is the main connection, under its old name.
    extra = chosen if chosen and chosen != agent else ""
    name = server_name(handle, extra)
    # The account is recognised by the KEY a connection sends, not by its name. A
    # name-only check let a legacy `extella` server (key in plain headers) and this
    # registrar's `extella_acct_…` coexist for one account — measured 30.09.2026.
    same_account = connections_of(handle, extra, agent)
    if same_account:
        return {"status": "exists", "server": same_account[0], "servers": same_account,
                "agent_id": extra or agent,
                "message": ("This " + ("agent" if extra else "account") +
                            " already has a connection (" + ", ".join(same_account) +
                            "); nothing was changed. A second one would duplicate it.")}
    if extra:
        # A chosen agent is proven BEFORE anything is written: a foreign or missing
        # agent leaves no file and no server behind.
        known = account_agents(token, agent)
        if known is not None and extra not in known:
            return {"status": "error", "agent_id": extra,
                    "message": (f"Agent {extra} is not in this key's account: either it belongs to "
                                "another account or it does not exist. Pick an agent from your own "
                                "list. Nothing was changed.")}
        ok, proof = prove_tool_call(headers_for(token, extra))
        if not ok:
            return {"status": "error", "agent_id": extra,
                    "message": (f"Extella did not accept agent {extra} with this key ({proof}). "
                                "Either the agent belongs to another account or it does not exist. "
                                "Pick an agent from your own list. Nothing was changed.")}
    claude = claude_command()
    if not claude:
        return {"status": "error", "message": "The `claude` command is not on PATH."}
    if is_windows() and not WIN_TOKEN_RE.match(token):
        return {"status": "error", "message": "The key has characters a Windows helper cannot "
                "pass safely; create a new token in Library → System → Tokens."}
    (h / ".extella" / "mcp").mkdir(parents=True, exist_ok=True)
    tf = token_file(handle, h)
    if is_windows():
        # No trailing newline: `set /p` would carry it into the header. The file sits in
        # the user's profile, which Windows already restricts to its owner; chmod is a no-op.
        hf = helper_file_windows(handle, h, extra)
        tf.write_text(token, encoding="utf-8")
        hf.write_text(helper_script_windows(handle, extra or agent), encoding="ascii", newline="")
        try:
            command = helper_command_windows(str(hf))
        except ValueError as e:
            return {"status": "error", "message": f"Cannot register on this Windows profile: {e}."}
    else:
        hf = helper_file(handle, h, extra)
        tf.write_text(token + "\n", encoding="utf-8")
        os.chmod(tf, 0o600)
        hf.write_text(helper_script(handle, extra or agent, h), encoding="utf-8")
        os.chmod(hf, 0o700)
        command = str(hf)
    done = subprocess.run(claude + ["mcp", "add-json", "--scope", "user", name,
                                    json.dumps(server_entry(command))],
                          capture_output=True, text=True, timeout=120)
    if done.returncode != 0:
        return {"status": "error", "message": "claude mcp add-json refused: " +
                (done.stdout + done.stderr).replace(token, "…")[:200]}
    try:
        sent = json.loads(run_helper(command).stdout or "{}")
    except ValueError:
        sent = {}
    ok, proof = prove_tool_call(sent)
    return {"status": "registered" if ok else "registered_unproven", "server": name,
            "account": handle, "agent_id": extra or agent, "proof": proof, "key_from": where,
            "message": f"Restart Claude Code, then call {PROOF_TOOL} of {name} (no arguments)."}


def _selftest_agents() -> list:
    """Several agents of one account, offline: a fake `claude`, a fake home, and the
    two network calls replaced by stand-ins. Nothing leaves the machine."""
    import tempfile
    fails = []
    g = globals()
    main, second, third = "agent_MainOfTheKey01", "agent_ChosenSecond01", "agent_ChosenThird001"
    stranger = "agent_SomeoneElses01"
    key = "selftest-key-0000-1111-2222"
    if agent_suffix(second) != hashlib.sha256(second.encode()).hexdigest()[:8]:
        fails.append("agent suffix is not the first 8 hex of sha256(agent_id)")
    handle = account_handle(key)
    if server_name(handle) != f"extella_{handle}":
        fails.append("the main connection changed its name")
    if server_name(handle, second) != f"extella_{handle}_{agent_suffix(second)}":
        fails.append("a chosen agent's server is not extella_<handle>_<suffix>")
    saved = {n: g[n] for n in ("validate", "prove_tool_call", "claude_command", "account_agents")}
    old_home, saved_env = os.environ.get("HOME"), os.environ.pop("EXTELLA_API_TOKEN", None)
    proofs = []
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["HOME"] = tmp
        cfg = pathlib.Path(tmp) / ".claude.json"
        fake = pathlib.Path(tmp) / "fake-claude"
        fake.write_text("#!" + sys.executable + "\n"
                        "import json, pathlib, sys\n"
                        f"p = pathlib.Path({str(cfg)!r})\n"
                        "c = json.loads(p.read_text()) if p.exists() else {}\n"
                        "c.setdefault('mcpServers', {})[sys.argv[5]] = json.loads(sys.argv[6])\n"
                        "p.write_text(json.dumps(c))\n", encoding="utf-8")
        os.chmod(fake, 0o700)

        def fake_prove(headers):
            proofs.append(headers.get("X-Agent-Id"))
            if headers.get("X-Agent-Id") == stranger:
                return False, "MCP refused the tool call"
            return True, f"{PROOF_TOOL} answered with account data"
        g["validate"] = lambda token: {"valid": True, "agent_id": main, "why": ""}
        g["prove_tool_call"] = fake_prove
        g["claude_command"] = lambda: [str(fake)]
        # The REST list of the account: None (unreadable) falls back to the proof call.
        g["account_agents"] = lambda token, main_agent: {main, second, third}
        try:
            (pathlib.Path(tmp) / ".extella").mkdir()
            (pathlib.Path(tmp) / ".extella" / "api_token.txt").write_text(key)
            r0 = register()
            if r0.get("status") != "registered" or r0.get("server") != server_name(handle):
                fails.append(f"without --agent the main connection is not registered as before: {r0.get('status')}")
            before = cfg.read_text()
            r1 = register(second)
            servers = json.loads(cfg.read_text())["mcpServers"]
            if r1.get("status") != "registered" or r1.get("agent_id") != second:
                fails.append(f"a chosen agent is not registered: {r1.get('status')}")
            if json.loads(before)["mcpServers"][server_name(handle)] != servers.get(server_name(handle)):
                fails.append("registering a second agent changed the main connection")
            hdrs, _ = server_headers(servers.get(server_name(handle, second)) or {})
            if hdrs.get("X-Agent-Id") != second or hdrs.get("X-Auth-Token") != key:
                fails.append("the chosen agent's helper does not send its own agent with the same key")
            hdrs0, _ = server_headers(servers[server_name(handle)])
            if hdrs0.get("X-Agent-Id") != main:
                fails.append("the main helper no longer sends the token's agent")
            if proofs[-2:] != [second, second]:
                fails.append("the chosen agent is not proven with its own X-Agent-Id")
            if register(second).get("status") != "exists" or register().get("status") != "exists":
                fails.append("re-registering the same agent is not idempotent")
            if len(json.loads(cfg.read_text())["mcpServers"]) != 2:
                fails.append("a repeated registration added a server")
            if register(third).get("status") != "registered" or \
                    len(json.loads(cfg.read_text())["mcpServers"]) != 3:
                fails.append("a third agent does not get its own connection")
            if register(main).get("status") != "exists":
                fails.append("choosing the token's own agent does not land on the main connection")
            snapshot = sorted(p.name for p in (pathlib.Path(tmp) / ".extella" / "mcp").iterdir())
            r_bad = register(stranger)
            if r_bad.get("status") != "error" or "another account" not in r_bad.get("message", ""):
                fails.append("a foreign agent is not refused in words")
            if len(json.loads(cfg.read_text())["mcpServers"]) != 3 or \
                    sorted(p.name for p in (pathlib.Path(tmp) / ".extella" / "mcp").iterdir()) != snapshot:
                fails.append("a refused agent left a file or a server behind")
            g["account_agents"] = lambda token, main_agent: None
            if register(stranger).get("status") != "error":
                fails.append("without the account list a foreign agent is not refused by the proof call")
            g["account_agents"] = lambda token, main_agent: {main, second, third, stranger + "x"}
            proofs.clear()
            r_list = register("agent_NotInAccount1")
            if r_list.get("status") != "error" or proofs:
                fails.append("an agent missing from the account list is not refused before the proof call")
            if len(json.loads(cfg.read_text())["mcpServers"]) != 3:
                fails.append("a refused agent added a server")
            if register("agent_x").get("status") != "error" or register("../../etc").get("status") != "error" \
                    or register("agent_12345678\n").get("status") != "error":
                fails.append("a malformed agent id is accepted")
            for f in (pathlib.Path(tmp) / ".extella" / "mcp").glob("*.sh"):
                if key in f.read_text():
                    fails.append("a helper carries the key inside itself")
            tf = token_file(handle, pathlib.Path(tmp))
            if (tf.stat().st_mode & 0o777) != 0o600:
                fails.append("the shared key file is not 0600")
            if key in json.dumps(r1) + json.dumps(r_bad) + cfg.read_text():
                fails.append("the key leaked into the output or the config")
            g["validate"] = lambda token: {"valid": True, "agent_id": main, "why": ""}
            rep = doctor()
            acct = next((a for a in rep["accounts"] if a["handle"] == handle), {})
            got = sorted(b["agent_id"] for b in acct.get("bindings", []))
            if got != sorted([main, second, third]):
                fails.append(f"doctor does not list the account's bindings with their agents: {got}")
            if rep["duplicates"]:
                fails.append("doctor calls several agents of one account duplicates")
        finally:
            g.update(saved)
            os.environ["HOME"] = old_home or ""
            if saved_env is not None:
                os.environ["EXTELLA_API_TOKEN"] = saved_env
    return fails


# ── self-test (offline) ────────────────────────────────────────────────────
def selftest() -> int:
    import tempfile
    fails = []
    h = pathlib.Path("/home/x")
    handle = account_handle("00000000-1111-2222-3333-444444444444")
    if not HANDLE_RE.match(handle):
        fails.append("handle has the wrong shape")
    if account_handle("  k-12345678 ") != account_handle("k-12345678"):
        fails.append("handle depends on surrounding spaces")
    script = helper_script(handle, "agent_abcdefgh12", h)
    if "k-12345678" in script or "00000000-1111" in script:
        fails.append("helper carries the key inside itself")
    if f"{h}/.extella/mcp/{handle}.token" not in script:
        fails.append("helper does not read the account's own token file")
    try:
        helper_script(handle, "", h)
        fails.append("helper accepted an empty agent id")
    except ValueError:
        pass
    if server_entry("/abs/x.sh") != {"type": "http", "url": MCP_URL, "headersHelper": "/abs/x.sh"}:
        fails.append("server entry differs from the bridge format")
    ok, why = prove_tool_call({"X-Auth-Token": "k-12345678", "X-Profile-Id": PROFILE})
    if ok or "X-Agent-Id" not in why:
        fails.append("missing X-Agent-Id is not named as the cause before any network call")
    if judge(None)[0] or judge({})[0]:
        fails.append("an unparsed or empty answer counts as proof — the false green of 30.09")
    if judge({"result": {"content": [{"text": "x"}]}})[0]:
        fails.append("an answer without isError=false counts as proof")
    if judge({"result": {"isError": True, "content": [{"text": "dependency 'token'"}]}})[0]:
        fails.append("a refused call counts as proof")
    if not judge({"result": {"isError": False, "content": [{"text": '{"profiles": []}'}]}})[0]:
        fails.append("a valid parsed answer is not accepted")
    # No root certificates (python.org Python on a Mac): the system bundle is loaded,
    # verification stays on.
    class _Empty:
        def __init__(self): self.loaded = []
        def cert_store_stats(self): return {"x509_ca": 1 if self.loaded else 0}
        def load_verify_locations(self, cafile=None): self.loaded.append(cafile)
    with tempfile.NamedTemporaryFile(suffix=".pem") as bundle:
        if tls_context(factory=_Empty, bundles=(bundle.name,)).loaded != [bundle.name]:
            fails.append("without its own CA bundle Python does not fall back to the system one")
    real = tls_context()
    if real.verify_mode != ssl.CERT_REQUIRED or not real.check_hostname:
        fails.append("certificate verification is not required")
    if "Install Certificates" not in network_reason(Exception("[SSL: CERTIFICATE_VERIFY_FAILED]")):
        fails.append("a certificate failure is not explained with the step to fix it")
    # The advice the user acts on must name the proof tool, not the one that overflows.
    src = pathlib.Path(__file__).read_text(encoding="utf-8")
    if any(n in src for n in ("call " + "list_agents", "list_" + "agents tool")):
        fails.append("the next action sends the user to list_agents, which overflows on a large account")
    if PROOF_TOOL == "get_current_profile_and_agent":
        fails.append("the proof tool echoes headers and accepts a wrong key")
    # Native Windows: the helper must carry no key, read its own token file, and be
    # callable by one string from Git Bash and from PowerShell.
    win = helper_script_windows(handle, "agent_abcdefgh12")
    if "k-12345678" in win or "00000000-1111" in win:
        fails.append("Windows helper carries the key inside itself")
    if f'<"%~dp0{handle}.token"' not in win or "\r\n" not in win or not win.startswith("@echo off"):
        fails.append("Windows helper does not read its own token file as a .cmd")
    if '"X-Agent-Id":"agent_abcdefgh12"' not in win or '"X-Auth-Token":"%EXTELLA_T%"' not in win:
        fails.append("Windows helper prints headers in a different shape")
    try:
        helper_script_windows(handle, "", )
        fails.append("Windows helper accepted an empty agent id")
    except ValueError:
        pass
    try:
        plain = helper_command_windows("C:\\Users\\ivan\\.extella\\mcp\\x.cmd")
    except ValueError:
        plain = ""
    if plain != "C:/Users/ivan/.extella/mcp/x.cmd":
        fails.append("helper command is not an unquoted forward-slash path")
    try:
        helper_command_windows("C:\\Users\\Ivan Petrov\\.extella\\mcp\\x.cmd") if not is_windows() else None
        if not is_windows():
            fails.append("a path with spaces passed: PowerShell and Git Bash would split it")
    except ValueError:
        pass
    for bad in ("abc&calc12", "abc%PATH%xyz", 'ab"cdefgh'):
        if WIN_TOKEN_RE.match(bad):
            fails.append(f"a key with cmd metacharacters is accepted on Windows: {bad[:4]}…")
    if not WIN_TOKEN_RE.match("00000000-1111-2222-3333-444444444444"):
        fails.append("an ordinary Extella key is refused on Windows")
    src_reg = src[src.index("def register()"):src.index("# ── self-test")]
    if "native Windows is not supported" in src_reg:
        fails.append("register still refuses native Windows")
    with tempfile.TemporaryDirectory() as tmp:
        old = os.environ.get("HOME")
        os.environ["HOME"] = tmp
        saved_env = os.environ.pop("EXTELLA_API_TOKEN", None)
        try:
            if keys_on_disk():
                fails.append("an empty home reported keys")
            # A legacy server under another name, key in plain headers, same account.
            legacy_key = "legacy-key-12345678"
            (pathlib.Path(tmp) / ".claude.json").write_text(json.dumps({"mcpServers": {
                "extella": {"type": "http", "url": MCP_URL,
                            "headers": {"X-Auth-Token": legacy_key}}}}), encoding="utf-8")
            if connections_of(account_handle(legacy_key)) != ["extella"]:
                fails.append("a legacy connection under another name is not recognised "
                             "as the same account — register would duplicate it")
            if connections_of(account_handle("another-key-12345678")):
                fails.append("another account's key is taken for this one")
            r = {"next_action": NO_KEY} if not keys_on_disk() else doctor()
            if "Tokens" not in r["next_action"] or "chat" not in r["next_action"]:
                fails.append("no-key action does not lead to the Tokens screen")
        finally:
            os.environ["HOME"] = old or ""
            if saved_env is not None:
                os.environ["EXTELLA_API_TOKEN"] = saved_env
    fails.extend(_selftest_agents())
    for f in fails:
        print("  ✗ " + f)
    print("SELFTEST: " + ("failures" if fails else "all checks passed"))
    return 1 if fails else 0


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:                                        # noqa: BLE001
            pass
    args = sys.argv[1:]
    if "--selftest" in args:
        sys.exit(selftest())
    chosen_agent = ""
    for i, a in enumerate(args):
        if a == "--agent":
            chosen_agent = args[i + 1] if i + 1 < len(args) else "-"
        elif a.startswith("--agent="):
            chosen_agent = a.split("=", 1)[1] or "-"
    out = register(chosen_agent) if "register" in args else doctor()
    if "--json" in args:
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(out, ensure_ascii=False, indent=2) if "register" in args else
              "\n".join([f"accounts: " + ", ".join(f"{a['handle']} valid={a.get('valid')} "
                                                  f"agent={a.get('agent_id')} bindings=" +
                           (", ".join(f"{b['server']}→{b['agent_id']}" for b in a.get("bindings", []))
                            or "none") for a in out["accounts"]) or "none",
                         *[f"server {s['name']} ({s['stored']}): "
                           f"{'PROVEN' if s['proven'] else 'NOT proven'} — {s['proof']}"
                           + (f"; {s['cause']}" if s.get('cause') else "") for s in out["servers"]],
                         *[f"DUPLICATE: {', '.join(d['servers'])} → one account" for d in out["duplicates"]],
                         "next: " + out["next_action"]]))
    sys.exit(0)
