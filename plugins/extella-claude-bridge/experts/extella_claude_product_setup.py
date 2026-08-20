def extella_claude_product_setup(action: str = "preflight", marketplace_path: str = "",
                                 offset: int = 0, limit: int = 0) -> str:
    import json, os, platform, shutil, subprocess, urllib.request

    MARKETPLACE = "extella-claude"
    PLUGIN = "extella-claude-bridge@extella-claude"
    VALIDATE_URL = "https://api.extella.ai/api/token/validate"
    MCP_URL = "https://api.extella.ai/mcp/"
    STORE_BASE = "https://os.extella.ai"
    APP_NAME = "Разработка на Extella"
    HOME = os.path.expanduser("~")
    MCP_DIR = os.path.join(HOME, ".extella", "mcp")
    BRIDGE_EXPERT = "extella_claude_account_bridge_v1"
    BRIDGE_CODE = (
        # Fython обрабатывает $-директивы до разбора строк, поэтому литерал,
        # начинающийся с $extens, обрывается прямо здесь: [Execution Error]
        # unterminated string literal (detected at line 14). Склейка прячет
        # директиву от препроцессора, а итоговая строка не меняется.
        '$' + 'extens("include.py")\n'
        'include("import os", [])\n'
        'include("import json", [])\n'
        'include("import time", [])\n'
        'include("import uuid", [])\n'
        'include("import hmac", [])\n'
        'include("import hashlib", [])\n'
        'include("import subprocess", [])\n'
        'include("import urllib.request", [])\n'
        'include("import urllib.error", [])\n'
        '\n'
        'def extella_claude_account_bridge_v1(\n'
        '    prompt: str = "",\n'
        '    conversation_id: str = "",\n'
        '    execution_profile_id: str = "answer-only",\n'
        '    max_output_tokens: int = 2000,\n'
        '    timeout_ms: int = 120000\n'
        ') -> str:\n'
        '    import os, json, time, uuid, hmac, hashlib, subprocess, urllib.request, urllib.error\n'
        '\n'
        '    def launch_environment(name):\n'
        '        try:\n'
        '            completed = subprocess.run(\n'
        '                ["/bin/launchctl", "getenv", name],\n'
        '                stdout=subprocess.PIPE,\n'
        '                stderr=subprocess.DEVNULL,\n'
        '                text=True,\n'
        '                timeout=5,\n'
        '                shell=False\n'
        '            )\n'
        '            if completed.returncode == 0 and completed.stdout.strip():\n'
        '                return completed.stdout.strip()\n'
        '        except Exception:\n'
        '            pass\n'
        '        return ""\n'
        '\n'
        '    def local_environment(name, default=""):\n'
        '        value = os.environ.get(name, "")\n'
        '        if value:\n'
        '            return value\n'
        '        value = launch_environment(name)\n'
        '        if value:\n'
        '            return value\n'
        '        return default\n'
        '\n'
        '    def strict_json(payload):\n'
        '        return json.dumps(\n'
        '            payload,\n'
        '            ensure_ascii=False,\n'
        '            separators=(",", ":")\n'
        '        )\n'
        '\n'
        '    # The Claude bridge runs as its own launchd service with its own secret and\n'
        '    # its own port, so a stale Codex value inherited by a long-running Extella\n'
        '    # worker must never be used here.\n'
        '    secret = launch_environment("EXTELLA_CLAUDE_BRIDGE_SECRET") or os.environ.get(\n'
        '        "EXTELLA_CLAUDE_BRIDGE_SECRET", ""\n'
        '    )\n'
        '    if len(secret.encode("utf-8")) < 32:\n'
        '        return strict_json({"status": "error", "code": "bridge_not_configured", "message": "Local Claude bridge is not configured"})\n'
        '    token = local_environment("EXTELLA_API_TOKEN")\n'
        '    if len(token) < 8:\n'
        '        return strict_json({"status": "error", "code": "extella_account_unavailable", "message": "Current Extella account is unavailable"})\n'
        '    if not prompt or len(prompt) > 4000:\n'
        '        return strict_json({"status": "error", "code": "invalid_prompt", "message": "prompt must contain 1..4000 characters"})\n'
        '    conversation_suffix = conversation_id[4:] if conversation_id.startswith("ctx_") else ""\n'
        '    if conversation_id and (\n'
        '        len(conversation_suffix) < 32 or\n'
        '        len(conversation_suffix) > 64 or\n'
        '        any(not (character.isalnum() or character in "_-") for character in conversation_suffix)\n'
        '    ):\n'
        '        return strict_json({"status": "error", "code": "invalid_conversation_id", "message": "conversation_id is invalid"})\n'
        '    known_execution_profiles = (\n'
        '        "answer-only",\n'
        '        "workspace-read",\n'
        '        "web-research"\n'
        '    )\n'
        '    if execution_profile_id not in known_execution_profiles:\n'
        '        return strict_json({\n'
        '            "status": "error",\n'
        '            "code": "execution_profile_unknown",\n'
        '            "message": "Execution profile is not recognized"\n'
        '        })\n'
        '    if max_output_tokens < 1 or max_output_tokens > 2000:\n'
        '        return strict_json({"status": "error", "code": "invalid_budget", "message": "max_output_tokens must be 1..2000"})\n'
        '    if timeout_ms < 1000 or timeout_ms > 120000:\n'
        '        return strict_json({"status": "error", "code": "invalid_budget", "message": "timeout_ms must be 1000..120000"})\n'
        '    try:\n'
        '        port = int(\n'
        '            launch_environment("EXTELLA_CLAUDE_BRIDGE_PORT") or\n'
        '            os.environ.get("EXTELLA_CLAUDE_BRIDGE_PORT", "0")\n'
        '        )\n'
        '    except Exception:\n'
        '        return strict_json({"status": "error", "code": "bridge_port_invalid", "message": "Local Claude bridge port is invalid"})\n'
        '    if port < 1024 or port > 65535:\n'
        '        return strict_json({"status": "error", "code": "bridge_port_invalid", "message": "Local Claude bridge port is invalid"})\n'
        '\n'
        '    account_binding = hmac.new(\n'
        '        secret.encode("utf-8"),\n'
        '        ("extella-account-v1." + token).encode("utf-8"),\n'
        '        hashlib.sha256\n'
        '    ).hexdigest()\n'
        '    token = ""\n'
        '    event_id = "evt_" + uuid.uuid4().hex\n'
        '    body = {\n'
        '        "schema_version": "1.3",\n'
        '        "event_id": event_id,\n'
        '        "account_binding": account_binding,\n'
        '        "capability": "general-assistance",\n'
        '        "provider": "claude",\n'
        '        "execution_profile_id": execution_profile_id,\n'
        '        "prompt": prompt,\n'
        '        "budget": {\n'
        '            "max_output_tokens": max_output_tokens,\n'
        '            "timeout_ms": timeout_ms\n'
        '        }\n'
        '    }\n'
        '    if conversation_id:\n'
        '        body["conversation_id"] = conversation_id\n'
        '    raw = json.dumps(\n'
        '        body,\n'
        '        ensure_ascii=False,\n'
        '        separators=(",", ":")\n'
        '    ).encode("utf-8")\n'
        '    timestamp = str(int(time.time()))\n'
        '    nonce = uuid.uuid4().hex\n'
        '    signed = timestamp.encode("utf-8") + b"." + nonce.encode("utf-8") + b"." + raw\n'
        '    digest = hmac.new(\n'
        '        secret.encode("utf-8"),\n'
        '        signed,\n'
        '        hashlib.sha256\n'
        '    ).hexdigest()\n'
        '    secret = ""\n'
        '    request = urllib.request.Request(\n'
        '        "http://127.0.0.1:" + str(port) + "/v1/delegate",\n'
        '        data=raw,\n'
        '        method="POST",\n'
        '        headers={\n'
        '            "Content-Type": "application/json",\n'
        '            "X-Extella-Timestamp": timestamp,\n'
        '            "X-Extella-Nonce": nonce,\n'
        '            "X-Extella-Signature": "sha256=" + digest\n'
        '        }\n'
        '    )\n'
        '    try:\n'
        '        with urllib.request.urlopen(\n'
        '            request,\n'
        '            timeout=max(2, int(timeout_ms / 1000) + 5)\n'
        '        ) as response:\n'
        '            result = json.loads(response.read(65536).decode("utf-8"))\n'
        '            if result.get("status") != "completed":\n'
        '                return strict_json(result)\n'
        '            if result.get("event_id") != event_id:\n'
        '                return strict_json({"status": "error", "code": "bridge_event_mismatch", "message": "Bridge event mismatch"})\n'
        '            return strict_json(result)\n'
        '    except urllib.error.HTTPError as error:\n'
        '        try:\n'
        '            failure = json.loads(error.read(65536).decode("utf-8"))\n'
        '            bridge_error = failure.get("error", {})\n'
        '            result = {\n'
        '                "status": "error",\n'
        '                "code": str(bridge_error.get("code", "bridge_http_error"))[:80],\n'
        '                "message": str(bridge_error.get("message", "Local Claude bridge rejected the request"))[:240]\n'
        '            }\n'
        '            if bridge_error.get("stage"):\n'
        '                result["stage"] = str(bridge_error.get("stage"))[:80]\n'
        '            if bridge_error.get("diagnostic_id"):\n'
        '                result["diagnostic_id"] = str(bridge_error.get("diagnostic_id"))[:128]\n'
        '            if isinstance(bridge_error.get("details"), dict):\n'
        '                result["details"] = bridge_error.get("details")\n'
        '            return strict_json(result)\n'
        '        except Exception:\n'
        '            return strict_json({"status": "error", "code": "bridge_http_error", "message": "Local Claude bridge rejected the request"})\n'
        '    except urllib.error.URLError:\n'
        '        return strict_json({\n'
        '            "status": "error",\n'
        '            "code": "bridge_unavailable",\n'
        '            "message": "Local Claude bridge is unavailable"\n'
        '        })\n'
        '    except Exception:\n'
        '        return strict_json({\n'
        '            "status": "error",\n'
        '            "code": "bridge_request_failed",\n'
        '            "message": "Local Claude bridge request failed"\n'
        '        })\n'
    )

    # H17: every return path is a JSON string, never a dict. The page unwraps
    # two envelopes and a Python repr would reach it as unparsable text.
    # Версия установщика едет в КАЖДОМ ответе. Без неё нельзя отличить
    # «исправление не помогло» от «отвечает старая версия», и мы потеряли на
    # этом два круга переписки с пользователем.
    SETUP_VERSION = "3.2.24"

    def result(status, code, message, **extra):
        payload = {"status": status, "code": code, "message": message,
                   "step": action, "setup_version": SETUP_VERSION,
                   "model_called": False,
                   "agent_called": False, "paid": False}
        payload.update(extra)
        return json.dumps(payload, ensure_ascii=False)

    # Приложение запускается из Finder, а не из терминала, и наследует
    # PATH=/usr/bin:/bin:/usr/sbin:/sbin. Поэтому shutil.which почти всегда
    # промахивается, и всё решает список ниже. Замер 17.08.2026: у владельца
    # claude лежит в ~/.local/bin и находится, у коллеги — «не установлен»
    # при установленном Claude, то есть каталог просто не входил в список.
    def shell_path_dirs():
        """PATH из логин-оболочки: он знает про nvm, asdf, volta и прочее,
        чего в жёстком списке быть не может."""
        shell = os.environ.get("SHELL") or "/bin/zsh"
        # Сначала интерактивный логин-шелл, потом просто логин. Замер
        # 17.08.2026 на машине коллеги: claude стоял в
        # ~/.nvm/versions/node/v24.16.0/bin, а "-lc" его не показал — zsh с
        # "-l" читает .zprofile и .zlogin, но НЕ .zshrc, а nvm настраивается
        # именно в .zshrc. Поэтому одного "-lc" мало.
        for flags in ("-ilc", "-lc"):
            try:
                completed = subprocess.run(
                    [shell, flags, "printf %s \"$PATH\""],
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    text=True, timeout=20, shell=False)
            except Exception:
                continue
            if completed and completed.returncode == 0:
                dirs = [part for part in (completed.stdout or "").split(":")
                        if part.startswith("/")]
                if dirs:
                    return dirs
        return []

    def version_manager_dirs():
        """Каталоги менеджеров версий node. Нужны отдельно: если оболочка
        молчит, глобус находит их и без неё."""
        found = []
        for base in [os.path.join(HOME, ".nvm", "versions", "node"),
                     os.path.join(HOME, ".fnm", "node-versions"),
                     os.path.join(HOME, "n", "versions", "node"),
                     os.path.join(HOME, ".volta", "tools", "image", "node")]:
            try:
                entries = sorted(os.listdir(base))
            except Exception:
                continue
            for entry in entries:
                for tail in ((entry, "bin"), (entry, "installation", "bin")):
                    candidate = os.path.join(base, *tail)
                    if os.path.isdir(candidate):
                        found.append(candidate)
        return found

    def candidate_roots():
        roots = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
                 os.path.join(HOME, ".local", "bin"),
                 os.path.join(HOME, ".npm-global", "bin"),
                 # Собственная локальная установка Claude Code и типовые
                 # менеджеры пакетов — самые частые места после homebrew.
                 os.path.join(HOME, ".claude", "local"),
                 os.path.join(HOME, ".bun", "bin"),
                 os.path.join(HOME, ".volta", "bin"),
                 os.path.join(HOME, "Library", "pnpm"),
                 os.path.join(HOME, ".yarn", "bin"),
                 os.path.join(HOME, ".asdf", "shims")]
        # Порядок: жёсткий список, затем менеджеры версий, затем PATH оболочки.
        # Дубликаты убираются с сохранением порядка — иначе отказ печатает один
        # и тот же каталог по пять раз и читается как мусор.
        ordered = []
        for root in roots + version_manager_dirs() + shell_path_dirs():
            if root not in ordered:
                ordered.append(root)
        return ordered

    def find(name):
        found = shutil.which(name)
        if found:
            return found
        for root in candidate_roots():
            candidate = os.path.join(root, name)
            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                return candidate
        return ""

    def safe_env():
        env = dict(os.environ)
        # Те же каталоги, в которых мы ищем CLI, обязаны быть в PATH при его
        # запуске: claude, поставленный через nvm, — это js-скрипт, которому
        # нужен node из соседнего каталога. Иначе он падает с "env: node:
        # No such file or directory", а это читается как «CLI сломан».
        env["PATH"] = ":".join(candidate_roots() + [env.get("PATH", "")])
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
        # Канонический источник токена — окружение процесса эксперта: листенер
        # кладёт его туда как EXTELLA_API_TOKEN (DEPLOY_REQUIREMENTS, п.3). Мы
        # это окружение НЕ читали — только файл и launchctl, а это другое. На
        # машине владельца выручал случайно существующий файл; у тестера файла
        # нет, и токен, уже вложенный листенером, установщик не видел.
        injected = os.environ.get("EXTELLA_API_TOKEN", "").strip()
        if len(injected) >= 8:
            return injected
        # Файл — тот, что приложение пишет само, когда его открывают на машине.
        # Владелец его руками не создаёт (замер: записан 30.07 с резервной
        # копией). Порядок совпадает с каноном store_app/update.py.
        for path in [os.path.join(HOME, ".extella", "api_token.txt")]:
            try:
                with open(path, "r", encoding="utf-8") as stream:
                    value = stream.read(4096).strip()
                if len(value) >= 8:
                    return value
            except Exception:
                pass
        probe = run(["/bin/launchctl", "getenv", "EXTELLA_API_TOKEN"], timeout=20)
        value = (probe.stdout or "").strip() if probe and probe.returncode == 0 else ""
        if len(value) >= 8:
            return value
        # Четвёртый канонный источник (store_app/update.py, PROMPT_UPDATE_AGENT):
        # собственный конфиг листенера. Если эксперт исполняется — листенер
        # авторизован, значит этот файл на машине есть. Замер 18.08.2026: на
        # машине тестера пусты окружение, файл и launchctl, при этом эксперт
        # работает — то есть токен лежал ровно здесь, а мы сюда не смотрели.
        # Из конфига берётся ТОЛЬКО токен: agent_id оттуда брать нельзя
        # (DEPLOY_REQUIREMENTS п.4 — там может стоять другой агент).
        try:
            with open(os.path.join(HOME, "extella_wizard", "app", "config.json"),
                      "r", encoding="utf-8") as stream:
                wizard = json.loads(stream.read(65536))
            for field in ("auth_token", "token", "AUTH_TOKEN", "extella_token"):
                candidate = str(wizard.get(field) or "").strip()
                if len(candidate) >= 8:
                    return candidate
        except Exception:
            pass
        return ""

    def token_sources_report():
        """Какие источники существуют, БЕЗ значений — только присутствие.
        Нужен отказу: пять кругов отладки ушло на то, чтобы узнать, чего
        именно на машине нет."""
        report = []
        report.append("окружение: " + ("есть" if len(os.environ.get("EXTELLA_API_TOKEN", "").strip()) >= 8 else "пусто"))
        report.append("файл api_token.txt: " + ("есть" if os.path.isfile(os.path.join(HOME, ".extella", "api_token.txt")) else "нет"))
        probe = run(["/bin/launchctl", "getenv", "EXTELLA_API_TOKEN"], timeout=20)
        report.append("launchctl: " + ("есть" if probe and probe.returncode == 0 and len((probe.stdout or "").strip()) >= 8 else "пусто"))
        report.append("конфиг листенера: " + ("есть" if os.path.isfile(os.path.join(HOME, "extella_wizard", "app", "config.json")) else "нет"))
        return "; ".join(report)

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

    # Измерено 16.08.2026: переустановка версии с архивом не разложила его на
    # диск — привязка осталась от прошлой распаковки. Полагаться на то, что
    # кто-то другой доставит рантайм, значит оставить кнопку сломанной там, где
    # этого не произошло. Магазин отдаёт архив по имени приложения, поэтому
    # этап bridge доносит его сам и делает это идемпотентно.
    def fetch_and_unpack_runtime(token_value, runtime_dir):
        import io, zipfile, urllib.parse
        query = urllib.parse.urlencode({"app": APP_NAME})
        request = urllib.request.Request(
            STORE_BASE + "/api/app-archive?" + query,
            headers={"X-Extella-Token": token_value})
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                if response.status != 200:
                    return "download_failed"
                blob = response.read(64 * 1024 * 1024)
        except Exception:
            return "download_failed"
        try:
            archive = zipfile.ZipFile(io.BytesIO(blob))
        except Exception:
            return "archive_invalid"
        wanted = []
        for name in archive.namelist():
            if name.endswith("/"):
                continue
            # Имена из архива — данные, а не путь: абсолютный путь или "..",
            # и распаковка пишет куда угодно за пределами каталога продукта.
            if name.startswith("/") or ".." in name.split("/"):
                return "archive_unsafe"
            if name.startswith("scripts/") or name.startswith("schemas/") or name == "install.py":
                wanted.append(name)
        if not any(n.startswith("scripts/") for n in wanted):
            return "archive_incomplete"
        try:
            for name in wanted:
                target = os.path.join(runtime_dir, name)
                os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
                with archive.open(name) as source:
                    data = source.read()
                descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(data)
        except Exception:
            return "unpack_failed"
        return ""

    # REST — штатный путь платформы; MCP у неё сейчас с проблемами, и команда
    # работает через REST осознанно. Здесь он же и используется.
    def core(path, payload, agent_id):
        try:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            request = urllib.request.Request(
                "https://api.extella.ai" + path, data=body, method="POST",
                headers={"Content-Type": "application/json",
                         "X-Auth-Token": ACCOUNT_TOKEN,
                         "X-Profile-Id": "default",
                         "X-Agent-Id": agent_id})
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.loads(response.read(262144).decode("utf-8") or "{}")
        except Exception:
            return None

    def stored_code(payload):
        if isinstance(payload, dict):
            for key in ("expert_code", "code"):
                if isinstance(payload.get(key), str):
                    return payload[key]
            for key in ("content", "data", "result", "expert"):
                found = stored_code(payload.get(key))
                if found:
                    return found
        return ""

    def agent_rows(payload):
        if isinstance(payload, list):
            return payload
        if isinstance(payload, dict):
            if isinstance(payload.get("agents"), list):
                return payload["agents"]
            for key in ("content", "data", "result"):
                rows = agent_rows(payload.get(key))
                if rows:
                    return rows
        return []

    # Каждая копия — своя запись в своём скоупе. Замер 17.08.2026: несколько
    # записей одного имени с global=false сосуществуют и изолированы полностью,
    # каждый скоуп исполняет свою. global=true так не работает: читается
    # отовсюду, исполняется только из скоупа последнего сохранения.
    #
    # Поэтому раздача и обновление — один и тот же шаг, и каждая копия
    # сверяется посимвольно. Иначе одна отставшая копия даёт молча старое
    # поведение у одного агента.
    # Правило сюда не входит намеренно. Правила читаются глобально — агент в
    # чате прочёл и исполнил account-global правило, это проверено. Копия
    # правила в каждом скоупе была бы 37 единицами мусора, которые потом
    # расходятся. Скоупным приходится делать только Expert, потому что у него
    # расходятся чтение и исполнение.
    # Раздача идёт порциями. Замер 17.08.2026: полный проход по 39 агентам
    # занимает больше минуты, и платформа откладывает такой вызов в задачу,
    # отвечая "deferred, use task_id as reference". Страница получает вместо
    # результата ссылку на задачу и показывает отказ. Порция укладывается в
    # обычный ответ, а вызывающий сам идёт по списку и складывает числа.
    def provision_scopes(code, offset=0, limit=0):
        listed = core("/api/agent/list", {}, "agent_XXXXXXXX")
        rows = agent_rows(listed)
        if not rows:
            return None, "agent_list_failed"
        total = len(rows)
        if limit > 0:
            rows = rows[offset:offset + limit]
        elif offset > 0:
            rows = rows[offset:]
        written = []
        runnable = []
        not_runnable = []
        skipped_public = []
        failed = []
        for row in rows:
            agent_id = str(row.get("id") or row.get("agent_id") or "")
            if not agent_id.startswith("agent_"):
                continue
            detail = core("/api/agent/get", {"agent_id": agent_id}, agent_id) or {}
            info = detail.get("agent") or detail.get("content") or detail
            if info.get("isPublic") is True or info.get("is_public") is True:
                # Публичный агент — общий платформенный объект; аккаунтная
                # запись в него не закрепится, и отчитываться об успехе нельзя.
                skipped_public.append(agent_id)
                continue
            saved = core("/api/expert/save", {
                "name": BRIDGE_EXPERT,
                "description": "Delegate a bounded text task to local Claude Code.",
                "code": code, "cspl": "fython", "global": False,
                "kwargs": {"prompt": "", "conversation_id": "",
                           "execution_profile_id": "answer-only",
                           "max_output_tokens": 2000, "timeout_ms": 120000},
            }, agent_id)
            if not saved:
                failed.append(agent_id)
                continue
            back = core("/api/expert/get", {"name": BRIDGE_EXPERT, "global": False}, agent_id)
            if stored_code(back).strip() != code.strip():
                failed.append(agent_id)
                continue
            written.append(agent_id)
            # Чтение доказывает хранение, а не запускаемость: измерено 17.08.2026,
            # что в одном скоупе из 38 запись читается посимвольно верной и при
            # этом run отвечает "Expert not found". Поэтому копия проверяется
            # запуском с пустым prompt — он безмодельный и отсекается уже внутри
            # моста, так что любой ответ моста доказывает, что Expert исполнился.
            # Поле timeout здесь запрещено: с 18.08.2026 core отвечает на него
            # 422 extra_forbidden, и проверка запуском падала у всех агентов.
            probe = core("/api/expert/run",
                         {"name": BRIDGE_EXPERT, "global": False,
                          "params": {"prompt": ""}}, agent_id)
            answer = json.dumps(probe, ensure_ascii=False) if probe else ""
            if "invalid_prompt" in answer or "bridge_not_configured" in answer:
                runnable.append(agent_id)
            else:
                not_runnable.append(agent_id)
        return {"written": written, "runnable": runnable,
                "not_runnable": not_runnable,
                "skipped_public": skipped_public, "failed": failed,
                "total": total, "next_offset": offset + len(rows)}, ""

    def handle_for(value):
        import hashlib
        digest = hashlib.sha256(("extella-mcp-account-v1." + value).encode("utf-8")).hexdigest()
        return "acct_" + digest[:12]

    # Отказ обязан называть действие. «Текущий аккаунт Extella недоступен» —
    # это констатация без следующего шага: человек не знает ни что токен нужен
    # создать самому, ни куда его положить. Тот же класс дефекта, что и
    # «не удалось проверить вход» вместо «войдите».
    # Канон store_app/update.py: токен кладёт приложение, а не пользователь
    # руками. Правильный следующий шаг — открыть Extella на этой машине, а не
    # создавать файл с секретом в редакторе.
    NO_TOKEN_MESSAGE = (
        "Токен Extella на этой машине не найден. Проверено — " +
        token_sources_report() +
        ". Откройте приложение Extella, войдите в аккаунт и повторите. "
        "Создавать файл вручную не нужно. Если не поможет — пришлите этот "
        "текст целиком."
    )

    ACCOUNT_TOKEN = token_from_disk()
    claude = find("claude")
    if platform.system() != "Darwin":
        return result("error", "unsupported_os", "Автоматическая установка пока поддерживает только macOS.")
    if not claude:
        # Сообщение называет, где искали: «не установлен» при установленном
        # Claude — это тупик, из которого пользователю некуда шагнуть.
        # Диагностика в самом отказе: домашний каталог, каким его видит
        # установщик, и что он находит в nvm. Терминал и установщик могут
        # смотреть на разные машины — буквально, если Expert исполняется не
        # там, где сидит человек.
        try:
            nvm_seen = sorted(os.listdir(os.path.join(HOME, ".nvm", "versions", "node")))
        except Exception:
            nvm_seen = []
        return result("error", "claude_not_installed",
                      "Claude Code не найден. HOME=" + HOME +
                      "; каталогов в поиске: " + str(len(candidate_roots())) +
                      "; PATH из оболочки прочитан: " +
                      ("да" if shell_path_dirs() else "НЕТ") +
                      "; nvm-версий видно: " + (", ".join(nvm_seen) if nvm_seen else "ни одной") +
                      ". Пришлите эту строку целиком.",
                      searched=len(candidate_roots()),
                      home=HOME,
                      shell_path_read=bool(shell_path_dirs()),
                      nvm_versions=nvm_seen[:8])

    if action == "preflight":
        version = run([claude, "--version"], timeout=20)
        if not version or version.returncode != 0:
            return result("error", "claude_version_check_failed", "Не удалось запустить Claude Code CLI.")
        # Замер 18.08.2026 на 2.1.210: у невошедшего пользователя команда
        # печатает корректный JSON {"loggedIn": false} и завершается с КОДОМ 1.
        # Проверка кода возврата превращала самое обычное состояние — «не
        # выполнен вход» — в «не удалось проверить вход», то есть в тупик
        # вместо инструкции. Поэтому сначала читаем вывод, и только если он
        # неразборчив, смотрим на код.
        status = run([claude, "auth", "status", "--json"], timeout=30)
        if not status:
            return result("error", "claude_auth_check_failed", "Не удалось проверить вход в Claude Code.")
        try:
            reported = json.loads(status.stdout or "")
        except Exception:
            reported = None
        if not isinstance(reported, dict):
            if status.returncode != 0:
                return result("error", "claude_auth_check_failed",
                              "Не удалось проверить вход в Claude Code: " +
                              ((status.stderr or status.stdout or "").strip()[:160] or "пустой ответ"))
            return result("error", "claude_auth_status_invalid", "Claude Code вернул неразборчивый статус входа.")
        logged_in = reported.get("loggedIn") is True
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
        # Плагин Claude Code — упаковочное удобство, а не рантайм. Измерено
        # 15.08.2026: с полностью снесённым плагином и удалённым marketplace оба
        # направления продолжают работать — MCP-соединение живо, мост отвечает.
        # Направление A держится записью MCP, которую делает этап credentials;
        # направление B — службой LaunchAgent, которую ставит этап bridge.
        # Плагин намеренно не несёт ни mcpServers, ни userConfig: один набор
        # userConfig не может представлять несколько аккаунтов.
        #
        # Поэтому отсутствие источника — это «не требуется», а не отказ. Иначе
        # кнопка упирается в тупик на продукте, который уже работает.
        source = marketplace_path if marketplace_path.startswith("/") else ""
        if not source:
            return result("success", "plugin_not_required",
                          "Плагин Claude Code не требуется: оба направления работают "
                          "без него. Он появится как упаковка после публикации.",
                          plugin_installed=False, plugin_required=False)
        if not os.path.isdir(source):
            return result("error", "plugin_source_unavailable",
                          "Указанный источник плагина Claude не найден.")
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
            return result("error", "extella_token_unavailable", NO_TOKEN_MESSAGE)
        agent_id = validate_token(token)
        if not agent_id:
            token = ""
            return result("error", "extella_token_invalid",
                          "Токен Extella не подтверждён сервером. Проверьте, что он "
                          "скопирован целиком и не отозван, затем повторите.")
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

    if action == "agents":
        # Раздача всем изменяемым агентам, а не одному и не по выбору
        # пользователя. Покупатель заранее не знает, из какого чата позовёт, а
        # «выбери агентов» требует понимания скоупов, которого у него нет.
        # Раздача и обновление — один шаг, каждая копия сверяется посимвольно.
        if len(ACCOUNT_TOKEN) < 8:
            return result("error", "extella_token_unavailable", NO_TOKEN_MESSAGE)
        # Порция по умолчанию подобрана по замеру: один агент — четыре вызова
        # ядра, восемь укладываются в обычный ответ с запасом.
        report, problem = provision_scopes(BRIDGE_CODE, int(offset or 0),
                                           int(limit or 8))
        if problem:
            return result("error", problem, "Не удалось прочитать список агентов Extella.")
        if report["failed"]:
            return result("error", "scope_provisioning_incomplete",
                          "Часть агентов не получила мост: обновите приложение и повторите.",
                          written=len(report["written"]),
                          failed=len(report["failed"]),
                          skipped_public=len(report["skipped_public"]))
        # Пустая порция — не отказ: в ней могли оказаться одни публичные агенты.
        # Отказ — когда по всему списку не запустился никто.
        finished = report["next_offset"] >= report["total"]
        if finished and not report["runnable"] and int(offset or 0) == 0:
            return result("error", "no_runnable_scope",
                          "Ни один агент не смог запустить мост после выдачи.",
                          written=len(report["written"]),
                          skipped_public=len(report["skipped_public"]))
        return result("success", "agents_provisioned",
                      "Мост выдан агентам Extella и проверен запуском.",
                      written=len(report["written"]),
                      runnable=len(report["runnable"]),
                      not_runnable=len(report["not_runnable"]),
                      skipped_public=len(report["skipped_public"]),
                      total=report["total"],
                      next_offset=report["next_offset"],
                      finished=finished,
                      note="запись проверена запуском, а не только чтением")

    if action == "bridge":
        # `__file__` не существует в Fython, и даже с ним каталога рядом нет:
        # Expert — запись в базе. Рантайм приезжает архивом листинга и
        # раскладывается установщиком в ~/extella_claude_bridge.
        runtime_dir = os.path.join(HOME, "extella_claude_bridge")
        script = os.path.join(runtime_dir, "scripts", "configure-claude-bridge-macos.mjs")
        if not os.path.isfile(script):
            token = token_from_disk()
            if len(token) < 8:
                return result("error", "extella_token_unavailable", NO_TOKEN_MESSAGE)
            problem = fetch_and_unpack_runtime(token, runtime_dir)
            token = ""
            if problem:
                return result("error", "bridge_runtime_missing",
                              "Локальная часть продукта не разложена и не скачалась. "
                              "Переустановите приложение из магазина.",
                              runtime_dir=runtime_dir, reason=problem)
        node = find("node")
        if not node:
            return result("error", "system_tools_missing", "На компьютере не найден node.")
        if not os.path.isfile(script):
            return result("error", "bridge_runtime_missing",
                          "Локальная часть продукта не разложена. Переустановите приложение "
                          "из магазина: рантайм моста приезжает архивом.",
                          runtime_dir=runtime_dir)
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
        provisioned = core("/api/expert/get", {"name": BRIDGE_EXPERT, "global": False},
                           validate_token(ACCOUNT_TOKEN) or "agent_XXXXXXXX")
        listed = run([claude, "mcp", "list"], timeout=60)
        # Presence only. The connected label in this output is not evidence of
        # authentication; the binding above is what proves the account.
        if not listed or ("extella_" + handle) not in (listed.stdout or ""):
            return result("error", "mcp_connection_missing", "Соединение Extella MCP не найдено в Claude Code.")
        # Наличие плагина сообщается, но готовностью не считается: измерено, что
        # со снесённым плагином оба направления продолжают работать.
        plugin_entry = installed_plugin(run([claude, "plugin", "list", "--json"], timeout=60))
        return result("success", "ready", "Claude Code подключён к Extella.",
                      plugin_installed=bool(plugin_entry), plugin_required=False,
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
        provisioned = core("/api/expert/get", {"name": BRIDGE_EXPERT, "global": False},
                           validate_token(ACCOUNT_TOKEN) or "agent_XXXXXXXX")
        listed = run([claude, "mcp", "list"], timeout=60)
        port_probe = run(["/bin/launchctl", "getenv", "EXTELLA_CLAUDE_BRIDGE_PORT"], timeout=20)
        port = (port_probe.stdout or "").strip() if port_probe else ""
        done = {
            "preflight": True,
            "credentials": bool(handle) and os.path.isfile(os.path.join(MCP_DIR, handle + ".sh"))
            and bool(listed) and ("extella_" + handle) in (listed.stdout or ""),
            "bridge": port.isdigit(),
        }
        # "verify" is not a thing that gets done and stays done; it is a
        # re-reading of the four above plus a live health check. Reporting it
        # as a completed step meant reporting False even right after it had
        # just returned ready, which is a status that contradicts the fact.
        remaining = [step for step in ("credentials", "bridge") if not done[step]]
        healthy = False
        if not remaining:
            try:
                with urllib.request.urlopen(
                        "http://127.0.0.1:" + port + "/health", timeout=10) as response:
                    health = json.loads(response.read(65536).decode("utf-8"))
                healthy = (health.get("status") == "ok" and
                           "claude" in health.get("providers", []))
            except Exception:
                healthy = False
        return result("success", "status_read", "Состояние установки прочитано.",
                      completed=done, bridge_healthy=healthy,
                      plugin_installed=bool(plugin_entry), plugin_required=False,
                      resume_from=(remaining[0] if remaining else None),
                      ready_to_verify=(not remaining and healthy),
                      plugin_version=str((plugin_entry or {}).get("version", ""))[:64])

    return result("error", "unsupported_step", "Установщик получил неизвестный этап.")
