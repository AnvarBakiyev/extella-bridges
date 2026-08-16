def extella_claude_product_setup(action: str = "preflight", marketplace_path: str = "") -> str:
    import json, os, platform, shutil, subprocess, urllib.request

    MARKETPLACE = "extella-claude"
    PLUGIN = "extella-claude-bridge@extella-claude"
    VALIDATE_URL = "https://api.extella.ai/api/token/validate"
    MCP_URL = "https://api.extella.ai/mcp/"
    HOME = os.path.expanduser("~")
    MCP_DIR = os.path.join(HOME, ".extella", "mcp")

    # H17: every return path is a JSON string, never a dict. The page unwraps
    # two envelopes and a Python repr would reach it as unparsable text.
    def result(status, code, message, **extra):
        payload = {"status": status, "code": code, "message": message,
                   "step": action, "model_called": False,
                   "agent_called": False, "paid": False}
        payload.update(extra)
        return json.dumps(payload, ensure_ascii=False)

    def find(name):
        found = shutil.which(name)
        if found:
            return found
        for root in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
                     os.path.join(HOME, ".local", "bin"),
                     os.path.join(HOME, ".npm-global", "bin")]:
            candidate = os.path.join(root, name)
            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                return candidate
        return ""

    def safe_env():
        env = dict(os.environ)
        env["PATH"] = ":".join(["/opt/homebrew/bin", "/usr/local/bin",
                                "/usr/bin", "/bin",
                                os.path.join(HOME, ".local", "bin"),
                                env.get("PATH", "")])
        env["NO_COLOR"] = "1"
        for key in ["EXTELLA_API_TOKEN", "EXTELLA_SECONDARY_API_TOKEN",
                    "EXTELLA_BRIDGE_SECRET", "EXTELLA_CLAUDE_BRIDGE_SECRET",
                    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY"]:
            env.pop(key, None)
        return env

    def run(args, timeout=120):
        try:
            return subprocess.run(args, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True,
                                  timeout=timeout, env=safe_env(), shell=False)
        except Exception:
            return None

    def token_from_disk():
        for path in [os.path.join(HOME, ".extella", "api_token.txt")]:
            try:
                with open(path, "r", encoding="utf-8") as stream:
                    value = stream.read(4096).strip()
                if len(value) >= 8:
                    return value
            except Exception:
                pass
        probe = run(["/bin/launchctl", "getenv", "EXTELLA_API_TOKEN"], timeout=20)
        return (probe.stdout or "").strip() if probe and probe.returncode == 0 else ""

    # The only proof of account binding. `claude mcp list` reports Connected
    # for a server with no token at all, because its health check is an MCP
    # initialize and that succeeds regardless. This endpoint does not, and it
    # also returns the agent id the Extella headers require. No model is used.
    def validate_token(value):
        try:
            body = json.dumps({"token": value}).encode("utf-8")
            request = urllib.request.Request(
                VALIDATE_URL, data=body,
                headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(request, timeout=15) as response:
                if response.status < 200 or response.status >= 300:
                    return None
                payload = json.loads(response.read(65537).decode("utf-8"))
            agent_id = str(payload.get("agent_id", "") or "")
            if payload.get("valid") is not True or not agent_id.startswith("agent_"):
                return None
            return agent_id
        except Exception:
            return None

    # Measured 2026-08-14 against Claude Code 2.1.81: `plugin list --json`
    # returns a bare JSON array whose entries carry id, version, scope,
    # enabled, installPath, installedAt, lastUpdated — and no "name" key at
    # all. Identity is the id, formatted "<plugin>@<marketplace>". An earlier
    # version of this function matched on "name" and therefore reported every
    # successful installation as unverified. The dict shapes are kept as a
    # tolerant fallback, not as the expectation.
    def installed_plugin(completed):
        if not completed or completed.returncode != 0:
            return None
        try:
            payload = json.loads(completed.stdout or "[]")
        except Exception:
            return None
        rows = payload if isinstance(payload, list) else (
            payload.get("plugins") or payload.get("installed") or [])
        for item in rows:
            if isinstance(item, dict) and item.get("id") == PLUGIN and item.get("enabled") is True:
                return item
        return None

    def marketplace_rows(completed):
        try:
            payload = json.loads((completed.stdout if completed else "") or "[]")
        except Exception:
            return []
        if isinstance(payload, list):
            return [item for item in payload if isinstance(item, dict)]
        return payload.get("marketplaces") or []

    # Measured 2026-08-14. Neither `initialize` nor `tools/list` can prove
    # authentication: both answer HTTP 200 identically with a valid token, with
    # no token, and with a deliberately wrong one, which is exactly why
    # `claude mcp list` shows every server as connected. A `tools/call` is the
    # first step that distinguishes them, and it needs no model — this Expert
    # is the MCP client, so nothing here consumes a plan or an API budget.
    #
    # list_agents was the obvious probe and the wrong one: its reply is tens of
    # kilobytes, so a bounded read truncated the JSON and a working connection
    # looked unauthorised. get_current_profile_and_agent is small but answers
    # identically with and without a token, so it proves nothing. list_profiles
    # is both small and discriminating: measured 638 bytes authorised against
    # 204 bytes refused.
    def mcp_probe(helper_path):
        try:
            completed = subprocess.run([helper_path], stdout=subprocess.PIPE,
                                       stderr=subprocess.DEVNULL, text=True,
                                       timeout=20, shell=False)
            headers = json.loads(completed.stdout or "{}")
        except Exception:
            return "inconclusive"
        if not isinstance(headers, dict) or not headers.get("X-Auth-Token"):
            return "refused"
        base = {"Accept": "application/json, text/event-stream",
                "Content-Type": "application/json"}

        def rpc(method, params, session=None, rid=1):
            body = json.dumps({"jsonrpc": "2.0", "id": rid,
                               "method": method, "params": params}).encode("utf-8")
            merged = dict(base)
            merged.update(headers)
            if session:
                merged["Mcp-Session-Id"] = session
            request = urllib.request.Request(MCP_URL, data=body, method="POST",
                                             headers=merged)
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.read(262144).decode("utf-8", "replace"), \
                    response.headers.get("Mcp-Session-Id")

        try:
            _, session = rpc("initialize", {
                "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": {"name": "extella-claude-setup", "version": "1"}})
            raw, _ = rpc("tools/call",
                         {"name": "list_profiles", "arguments": {}},
                         session=session, rid=2)
        except Exception:
            return "inconclusive"
        # Parse the envelope instead of scanning for substrings: the account
        # payload legitimately contains the word "error" inside agent data, and
        # a naive scan reported a working connection as unauthorised.
        payload = None
        for line in raw.splitlines():
            line = line.strip()
            candidate = line[5:].strip() if line.startswith("data:") else line
            if not candidate.startswith("{"):
                continue
            try:
                parsed = json.loads(candidate)
            except Exception:
                continue
            if isinstance(parsed, dict) and parsed.get("jsonrpc") == "2.0":
                payload = parsed
        # An unreadable envelope is not evidence of refusal. Saying so would
        # send the owner hunting for a credential problem that may not exist.
        if not isinstance(payload, dict):
            return "inconclusive"
        outcome = payload.get("result")
        if "error" in payload or (isinstance(outcome, dict) and outcome.get("isError") is True):
            return "refused"
        return "authorised" if isinstance(outcome, dict) else "inconclusive"

    def handle_for(value):
        import hashlib
        digest = hashlib.sha256(("extella-mcp-account-v1." + value).encode("utf-8")).hexdigest()
        return "acct_" + digest[:12]

    claude = find("claude")
    if platform.system() != "Darwin":
        return result("error", "unsupported_os", "Автоматическая установка пока поддерживает только macOS.")
    if not claude:
        return result("error", "claude_not_installed", "Claude Code не установлен на этом компьютере.")

    if action == "preflight":
        version = run([claude, "--version"], timeout=20)
        if not version or version.returncode != 0:
            return result("error", "claude_version_check_failed", "Не удалось запустить Claude Code CLI.")
        status = run([claude, "auth", "status", "--json"], timeout=30)
        if not status or status.returncode != 0:
            return result("error", "claude_auth_check_failed", "Не удалось проверить вход в Claude Code.")
        try:
            logged_in = json.loads(status.stdout or "{}").get("loggedIn") is True
        except Exception:
            return result("error", "claude_auth_status_invalid", "Claude Code вернул неразборчивый статус входа.")
        if not logged_in:
            # Never performed automatically: signing in is the owner's action.
            return result("error", "claude_auth_required",
                          "Войдите в Claude Code на этом компьютере: выполните `claude auth login`, затем повторите.")
        if not find("node"):
            return result("error", "system_tools_missing", "На компьютере не найден node.")
        return result("success", "preflight_ok", "Проверки пройдены.",
                      claude_version=(version.stdout or "").strip()[:120],
                      claude_login_state="reported_signed_in")

    if action == "install":
        source = marketplace_path if marketplace_path.startswith("/") else ""
        if not source or not os.path.isdir(source):
            return result("error", "plugin_source_unavailable",
                          "Не указан проверенный источник плагина Claude.")
        listing = run([claude, "plugin", "marketplace", "list", "--json"], timeout=45)
        if listing and listing.returncode == 0:
            # Measured 2026-08-14: this command also returns a bare JSON array.
            # Its entries do carry "name" — unlike plugin list, which has no
            # such key. Reading it as {"marketplaces": [...]} raised on the
            # list and was swallowed, so an existing source was never refreshed.
            existing = marketplace_rows(listing)
            if any(item.get("name") == MARKETPLACE for item in existing):
                run([claude, "plugin", "marketplace", "remove", MARKETPLACE], timeout=90)
        added = run([claude, "plugin", "marketplace", "add", source, "--scope", "user"], timeout=180)
        if not added or added.returncode != 0:
            return result("error", "marketplace_add_failed", "Claude Code не смог добавить проверенный источник Extella.")
        installed = run([claude, "plugin", "install", PLUGIN, "--scope", "user"], timeout=180)
        if not installed or installed.returncode != 0:
            return result("error", "plugin_install_failed", "Claude Code не смог установить плагин Extella.")
        verified = run([claude, "plugin", "list", "--json"], timeout=60)
        entry = installed_plugin(verified)
        if not entry:
            return result("error", "plugin_verification_failed", "Claude Code не подтвердил установленный плагин Extella.")
        # `version` is a commit SHA for a git-sourced plugin, so it is reported
        # rather than compared against a semantic version.
        return result("success", "plugin_installed", "Плагин Extella установлен в Claude Code.",
                      plugin_id=entry.get("id"), plugin_version=str(entry.get("version", ""))[:64],
                      plugin_scope=entry.get("scope"))

    if action == "credentials":
        token = token_from_disk()
        if len(token) < 8:
            return result("error", "extella_token_unavailable", "Текущий аккаунт Extella недоступен.")
        agent_id = validate_token(token)
        if not agent_id:
            token = ""
            return result("error", "extella_token_invalid", "Токен текущего аккаунта Extella не подтверждён.")
        handle = handle_for(token)
        try:
            os.makedirs(MCP_DIR, mode=0o700, exist_ok=True)
            os.chmod(MCP_DIR, 0o700)
            token_path = os.path.join(MCP_DIR, handle + ".token")
            descriptor = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(descriptor, "w") as stream:
                stream.write(token)
            # The helper reads the token at request time. It never receives it
            # as an argument, so it appears in no process listing, and
            # `claude mcp get` has no header value to print.
            helper_path = os.path.join(MCP_DIR, handle + ".sh")
            descriptor = os.open(helper_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o700)
            with os.fdopen(descriptor, "w") as stream:
                stream.write(
                    "#!/bin/sh\n"
                    "printf '{\"X-Auth-Token\":\"%s\",\"X-Profile-Id\":\"default\","
                    "\"X-Agent-Id\":\"" + agent_id + "\"}\\n' \"$(cat " + json.dumps(token_path) + ")\"\n")
            run(["/bin/launchctl", "setenv", "EXTELLA_API_TOKEN", token], timeout=20)
        except Exception:
            token = ""
            return result("error", "credential_setup_failed", "Не удалось подготовить локальные учётные данные Extella.")
        token = ""
        server = "extella_" + handle
        entry = json.dumps({"type": "http", "url": MCP_URL, "headersHelper": helper_path})
        run([claude, "mcp", "remove", server, "-s", "user"], timeout=30)
        added = run([claude, "mcp", "add-json", server, entry, "--scope", "user"], timeout=60)
        if not added or added.returncode != 0:
            return result("error", "mcp_connection_failed", "Не удалось настроить соединение Extella MCP.")
        return result("success", "credentials_configured",
                      "Аккаунт Extella подключён отдельным соединением.",
                      mcp_server=server, account_handle=handle)

    if action == "bridge":
        script = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                              "scripts", "configure-claude-bridge-macos.mjs")
        node = find("node")
        if not node or not os.path.isfile(script):
            return result("error", "bridge_script_unavailable", "Не найден проверенный установщик локального моста Claude.")
        configured = run([node, script, "--account-wide",
                          "--confirm-account-scope", "I_UNDERSTAND_ALL_AGENTS",
                          "--capability", "general-assistance",
                          "--confirm-live-cost", "I_UNDERSTAND_COST"], timeout=240)
        if not configured or configured.returncode != 0:
            detail = (configured.stderr or "").lower() if configured else ""
            if "unavailable" in detail and "port" in detail:
                return result("error", "bridge_port_unavailable", "Порт локального моста Claude уже занят.")
            return result("error", "bridge_setup_failed", "Не удалось запустить локальный мост Claude.")
        try:
            payload = json.loads(configured.stdout or "{}")
        except Exception:
            payload = {}
        if payload.get("status") != "configured" or payload.get("provider") != "claude":
            return result("error", "bridge_verification_failed", "Локальный мост Claude не подтвердил конфигурацию.")
        return result("success", "bridge_ready", "Локальный мост Claude запущен.",
                      bridge_port=payload.get("port"), live_enabled=True,
                      authorization_scope="account")

    if action == "verify":
        token = token_from_disk()
        agent_id = validate_token(token) if len(token) >= 8 else None
        handle = handle_for(token) if len(token) >= 8 else ""
        token = ""
        if not agent_id:
            return result("error", "account_binding_unverified", "Привязка аккаунта Extella не подтверждена.")
        port_probe = run(["/bin/launchctl", "getenv", "EXTELLA_CLAUDE_BRIDGE_PORT"], timeout=20)
        port = (port_probe.stdout or "").strip() if port_probe else ""
        if not port.isdigit():
            return result("error", "bridge_not_configured", "Локальный мост Claude не настроен.")
        try:
            with urllib.request.urlopen("http://127.0.0.1:" + port + "/health", timeout=10) as response:
                health = json.loads(response.read(65536).decode("utf-8"))
        except Exception:
            return result("error", "bridge_unreachable", "Локальный мост Claude не отвечает.")
        if (health.get("status") != "ok" or health.get("live_enabled") is not True or
                "claude" not in health.get("providers", []) or
                "account" not in health.get("authorization_scopes", []) or
                health.get("default_execution_profile_id") != "answer-only"):
            return result("error", "bridge_verification_failed", "Локальный мост Claude не подтвердил режим account-wide.")
        helper_path = os.path.join(MCP_DIR, handle + ".sh")
        if not os.path.isfile(helper_path):
            return result("error", "mcp_connection_missing", "Соединение Extella MCP не настроено.")
        probe = mcp_probe(helper_path)
        if probe == "refused":
            return result("error", "mcp_authentication_failed",
                          "Соединение Extella MCP не проходит авторизацию.")
        if probe != "authorised":
            return result("error", "mcp_probe_inconclusive",
                          "Не удалось подтвердить авторизацию соединения Extella MCP.")
        listed = run([claude, "mcp", "list"], timeout=60)
        # Presence only. The connected label in this output is not evidence of
        # authentication; the binding above is what proves the account.
        if not listed or ("extella_" + handle) not in (listed.stdout or ""):
            return result("error", "mcp_connection_missing", "Соединение Extella MCP не найдено в Claude Code.")
        if not installed_plugin(run([claude, "plugin", "list", "--json"], timeout=60)):
            return result("error", "plugin_verification_failed", "Claude Code не подтвердил установленный плагин Extella.")
        return result("success", "ready", "Claude Code подключён к Extella.",
                      authorization_scope="account", live_enabled=True,
                      bridge_port=int(port), mcp_server="extella_" + handle,
                      account_binding_proved_by="token_validate",
                      mcp_authentication_proved_by="mcp_tools_call",
                      execution_policy_version=health.get("execution_policy_version"),
                      default_execution_profile_id=health.get("default_execution_profile_id"))

    # A partially failed install must be resumable rather than blindly
    # repeated. This step reports which of the five are already done, reads
    # only, and calls neither a model nor Extella.
    if action == "status":
        plugin_entry = installed_plugin(run([claude, "plugin", "list", "--json"], timeout=60))
        token = token_from_disk()
        handle = handle_for(token) if len(token) >= 8 else ""
        token = ""
        helper_path = os.path.join(MCP_DIR, handle + ".sh")
        if not os.path.isfile(helper_path):
            return result("error", "mcp_connection_missing", "Соединение Extella MCP не настроено.")
        probe = mcp_probe(helper_path)
        if probe == "refused":
            return result("error", "mcp_authentication_failed",
                          "Соединение Extella MCP не проходит авторизацию.")
        if probe != "authorised":
            return result("error", "mcp_probe_inconclusive",
                          "Не удалось подтвердить авторизацию соединения Extella MCP.")
        listed = run([claude, "mcp", "list"], timeout=60)
        port_probe = run(["/bin/launchctl", "getenv", "EXTELLA_CLAUDE_BRIDGE_PORT"], timeout=20)
        port = (port_probe.stdout or "").strip() if port_probe else ""
        done = {
            "preflight": True,
            "install": bool(plugin_entry),
            "credentials": bool(handle) and os.path.isfile(os.path.join(MCP_DIR, handle + ".sh"))
            and bool(listed) and ("extella_" + handle) in (listed.stdout or ""),
            "bridge": port.isdigit(),
            "verify": False,
        }
        remaining = [step for step in ["install", "credentials", "bridge", "verify"] if not done[step]]
        return result("success", "status_read", "Состояние установки прочитано.",
                      completed=done, resume_from=(remaining[0] if remaining else "verify"),
                      plugin_version=str((plugin_entry or {}).get("version", ""))[:64])

    return result("error", "unsupported_step", "Установщик получил неизвестный этап.")
