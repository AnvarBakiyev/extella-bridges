// ── CLAUDE CONNECTOR INSTALLER ─────────────────────────────────────────────
// Trusted host-side installer for the dedicated Claude button in the Extella
// storefront. The iframe supplies nothing: no Expert name, no shell command,
// no repository, ref, credential, or target device. Every mutable value below
// is pinned in this signed toolbar release.
//
// Unlike the Codex installer this provisions one Expert rather than six. That
// Expert was measured end to end on a live host, so splitting it into compact
// per-step Experts to work around Fython's background-worker behaviour is a
// change to make if that behaviour appears, not before.

ETB.claudeInstaller = (function () {
  var EXPERT_NAME = 'extella_claude_product_setup';
  var EXPERT_SHA256 = 'f55af1b1892da906deefed5600d7dcb20ecef23bf82256ee3b31729cb191c18d';
  var PLUGIN_VERSION = '0.1.0-poc';
  var BRIDGE_PORT = 18788;
  var STATE_KEY = 'extella:claude-connection:v1';
  var EXECUTION_POLICY_VERSION = '1.0';
  var DEFAULT_EXECUTION_PROFILE_ID = 'answer-only';

  // Ordered, and each one is a separate call. A step that fails leaves the
  // earlier ones done, which is what makes the resume path below meaningful.
  var STEPS = ['preflight', 'install', 'credentials', 'bridge', 'verify'];
  var LONG_STEPS = { install: true, bridge: true };

  var ROUTING_RULE_MARKER = 'EXTELLA_CLAUDE_ROUTING_V1';
  // Две поправки, купленные замерами, а не рассуждением.
  //
  // Первая: «вызывай инструмент напрямую, если он доступен» удалено. Запись в
  // agent.tools сохраняет строку в конфигурации, но не превращает Expert в
  // function schema модели: у проверенных чат-агентов моста нет в списке
  // функций ни под каким именем — ни Claude, ни Codex. Обещать путь, которого
  // нет, хуже, чем не обещать ничего.
  //
  // Вторая: запрет на run_expert без targets снят для чата. Мой замер «без
  // targets уходит в облако» сделан из ВНЕШНЕГО MCP, где цель по умолчанию —
  // облачный VPS. В чате цель по умолчанию — машина пользователя, и там это
  // единственный работающий вызов; он же и подтверждён живым ответом Claude.
  // Обобщать один контекст на все было ошибкой.
  var ROUTING_RULE_TEXT = ROUTING_RULE_MARKER +
    ': ВЫЗОВ CLAUDE. Вызывай run_expert с ' +
    'name="extella_claude_account_bridge_v1" и ОБЯЗАТЕЛЬНО global=true. ' +
    'Из обычного чата этого достаточно: targets НЕ указывай — вызов исполнится ' +
    'в контексте цели самого чата, то есть на машине пользователя. ' +
    'ЕСЛИ ОТВЕТ bridge_not_configured — значит вызов ушёл не на ту машину. ' +
    'Так бывает у внешних подключений, где цель по умолчанию чужая. Тогда, и ' +
    'только тогда: search_targets по описанию рабочего листенера, взять записи ' +
    'с available=true, проверить каждую вызовом моста с пустым prompt (ответ ' +
    'bridge_not_configured значит, что моста там нет, любой другой ответ моста ' +
    'значит, что он есть) и повторить вызов с targets=[device_id] найденной ' +
    'цели. Если search_targets вернул пусто — это не «целей нет», а «ты в чате»: ' +
    'вызывай без targets. Никогда не запоминай device_id между вызовами: ' +
    'устройства перерегистрируются, разрешай цель заново. ' +
    'ЕСЛИ ОТВЕТ Expert not found — Expert существует, но не разрешается в твоём ' +
    'скоупе. Повторять бесполезно, targets и pin не помогают. Сообщи об этом ' +
    'словами и остановись. ' +
    'Никогда не подставляй вместо моста другого агента на модели Claude: ' +
    'локальный мост и облачный Claude-агент — разные вещи, и пользователь ' +
    'просит именно мост. Не вызывай get_expert или search_experts заранее. ' +
    'ПАРАМЕТРЫ: prompt, conversation_id текущего чата, execution_profile_id. ' +
    'Используй execution_profile_id="answer-only", если пользователь явно не ' +
    'выбрал другой профиль, о котором мост сообщил как о доступном. Сохранённый ' +
    'conversation_id всегда сохраняет свой исходный execution_profile_id; чтобы ' +
    'сменить профиль, начни новый разговор с Claude. Никогда не передавай через ' +
    'Expert сырые флаги рантайма, инструментов, повторов, файловой системы, сети ' +
    'или оболочки. ' +
    'РЕЖИМ. По умолчанию режим Claude выключен. Разовая просьба вызвать или ' +
    'спросить Claude выполняет один вызов и режим не включает. Когда ' +
    'пользователь явно просит начать, войти или перейти в непрерывный диалог с ' +
    'Claude, вызови Claude и после успешного вызова считай режим Claude активным ' +
    'в этом чате. Пока режим активен, направляй каждое следующее сообщение ' +
    'пользователя прямо в Claude, не требуя упоминать Claude снова, и всегда ' +
    'переиспользуй conversation_id, полученный в этом же чате. Когда пользователь ' +
    'просит остановить, выйти или вернуться из режима Claude, не отправляй эту ' +
    'команду в Claude: выключи режим и ответь сам. ' +
    'ГРАНИЦЫ. Если conversation_id в этом чате ещё нет, опусти его — мост создаст ' +
    'новую сессию Claude. Никогда не переиспользуй conversation_id из другого ' +
    'чата и никогда не сокращай и не пересказывай историю сессии Claude. Никогда ' +
    'не используй run_agent и не запускай второго агента Extella. Не вызывай ' +
    'Claude, если пользователь явно не попросил или режим Claude в этом чате не ' +
    'активен.';

  var _running = false;

  var EXPERT_CODE = [
    "def extella_claude_product_setup(action: str = \"preflight\", marketplace_path: str = \"\") -> str:",
    "    import json, os, platform, shutil, subprocess, urllib.request",
    "",
    "    MARKETPLACE = \"extella-claude\"",
    "    PLUGIN = \"extella-claude-bridge@extella-claude\"",
    "    VALIDATE_URL = \"https://api.extella.ai/api/token/validate\"",
    "    MCP_URL = \"https://api.extella.ai/mcp/\"",
    "    STORE_BASE = \"https://os.extella.ai\"",
    "    APP_NAME = \"Разработка на Extella\"",
    "    HOME = os.path.expanduser(\"~\")",
    "    MCP_DIR = os.path.join(HOME, \".extella\", \"mcp\")",
    "",
    "    # H17: every return path is a JSON string, never a dict. The page unwraps",
    "    # two envelopes and a Python repr would reach it as unparsable text.",
    "    def result(status, code, message, **extra):",
    "        payload = {\"status\": status, \"code\": code, \"message\": message,",
    "                   \"step\": action, \"model_called\": False,",
    "                   \"agent_called\": False, \"paid\": False}",
    "        payload.update(extra)",
    "        return json.dumps(payload, ensure_ascii=False)",
    "",
    "    def find(name):",
    "        found = shutil.which(name)",
    "        if found:",
    "            return found",
    "        for root in [\"/opt/homebrew/bin\", \"/usr/local/bin\", \"/usr/bin\", \"/bin\",",
    "                     os.path.join(HOME, \".local\", \"bin\"),",
    "                     os.path.join(HOME, \".npm-global\", \"bin\")]:",
    "            candidate = os.path.join(root, name)",
    "            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):",
    "                return candidate",
    "        return \"\"",
    "",
    "    def safe_env():",
    "        env = dict(os.environ)",
    "        env[\"PATH\"] = \":\".join([\"/opt/homebrew/bin\", \"/usr/local/bin\",",
    "                                \"/usr/bin\", \"/bin\",",
    "                                os.path.join(HOME, \".local\", \"bin\"),",
    "                                env.get(\"PATH\", \"\")])",
    "        env[\"NO_COLOR\"] = \"1\"",
    "        for key in [\"EXTELLA_API_TOKEN\", \"EXTELLA_SECONDARY_API_TOKEN\",",
    "                    \"EXTELLA_BRIDGE_SECRET\", \"EXTELLA_CLAUDE_BRIDGE_SECRET\",",
    "                    \"ANTHROPIC_API_KEY\", \"OPENAI_API_KEY\", \"CODEX_API_KEY\"]:",
    "            env.pop(key, None)",
    "        return env",
    "",
    "    def run(args, timeout=120):",
    "        try:",
    "            return subprocess.run(args, stdout=subprocess.PIPE,",
    "                                  stderr=subprocess.PIPE, text=True,",
    "                                  timeout=timeout, env=safe_env(), shell=False)",
    "        except Exception:",
    "            return None",
    "",
    "    def token_from_disk():",
    "        for path in [os.path.join(HOME, \".extella\", \"api_token.txt\")]:",
    "            try:",
    "                with open(path, \"r\", encoding=\"utf-8\") as stream:",
    "                    value = stream.read(4096).strip()",
    "                if len(value) >= 8:",
    "                    return value",
    "            except Exception:",
    "                pass",
    "        probe = run([\"/bin/launchctl\", \"getenv\", \"EXTELLA_API_TOKEN\"], timeout=20)",
    "        return (probe.stdout or \"\").strip() if probe and probe.returncode == 0 else \"\"",
    "",
    "    # The only proof of account binding. `claude mcp list` reports Connected",
    "    # for a server with no token at all, because its health check is an MCP",
    "    # initialize and that succeeds regardless. This endpoint does not, and it",
    "    # also returns the agent id the Extella headers require. No model is used.",
    "    def validate_token(value):",
    "        try:",
    "            body = json.dumps({\"token\": value}).encode(\"utf-8\")",
    "            request = urllib.request.Request(",
    "                VALIDATE_URL, data=body,",
    "                headers={\"Content-Type\": \"application/json\"}, method=\"POST\")",
    "            with urllib.request.urlopen(request, timeout=15) as response:",
    "                if response.status < 200 or response.status >= 300:",
    "                    return None",
    "                payload = json.loads(response.read(65537).decode(\"utf-8\"))",
    "            agent_id = str(payload.get(\"agent_id\", \"\") or \"\")",
    "            if payload.get(\"valid\") is not True or not agent_id.startswith(\"agent_\"):",
    "                return None",
    "            return agent_id",
    "        except Exception:",
    "            return None",
    "",
    "    # Measured 2026-08-14 against Claude Code 2.1.81: `plugin list --json`",
    "    # returns a bare JSON array whose entries carry id, version, scope,",
    "    # enabled, installPath, installedAt, lastUpdated — and no \"name\" key at",
    "    # all. Identity is the id, formatted \"<plugin>@<marketplace>\". An earlier",
    "    # version of this function matched on \"name\" and therefore reported every",
    "    # successful installation as unverified. The dict shapes are kept as a",
    "    # tolerant fallback, not as the expectation.",
    "    def installed_plugin(completed):",
    "        if not completed or completed.returncode != 0:",
    "            return None",
    "        try:",
    "            payload = json.loads(completed.stdout or \"[]\")",
    "        except Exception:",
    "            return None",
    "        rows = payload if isinstance(payload, list) else (",
    "            payload.get(\"plugins\") or payload.get(\"installed\") or [])",
    "        for item in rows:",
    "            if isinstance(item, dict) and item.get(\"id\") == PLUGIN and item.get(\"enabled\") is True:",
    "                return item",
    "        return None",
    "",
    "    def marketplace_rows(completed):",
    "        try:",
    "            payload = json.loads((completed.stdout if completed else \"\") or \"[]\")",
    "        except Exception:",
    "            return []",
    "        if isinstance(payload, list):",
    "            return [item for item in payload if isinstance(item, dict)]",
    "        return payload.get(\"marketplaces\") or []",
    "",
    "    # Measured 2026-08-14. Neither `initialize` nor `tools/list` can prove",
    "    # authentication: both answer HTTP 200 identically with a valid token, with",
    "    # no token, and with a deliberately wrong one, which is exactly why",
    "    # `claude mcp list` shows every server as connected. A `tools/call` is the",
    "    # first step that distinguishes them, and it needs no model — this Expert",
    "    # is the MCP client, so nothing here consumes a plan or an API budget.",
    "    #",
    "    # list_agents was the obvious probe and the wrong one: its reply is tens of",
    "    # kilobytes, so a bounded read truncated the JSON and a working connection",
    "    # looked unauthorised. get_current_profile_and_agent is small but answers",
    "    # identically with and without a token, so it proves nothing. list_profiles",
    "    # is both small and discriminating: measured 638 bytes authorised against",
    "    # 204 bytes refused.",
    "    def mcp_probe(helper_path):",
    "        try:",
    "            completed = subprocess.run([helper_path], stdout=subprocess.PIPE,",
    "                                       stderr=subprocess.DEVNULL, text=True,",
    "                                       timeout=20, shell=False)",
    "            headers = json.loads(completed.stdout or \"{}\")",
    "        except Exception:",
    "            return \"inconclusive\"",
    "        if not isinstance(headers, dict) or not headers.get(\"X-Auth-Token\"):",
    "            return \"refused\"",
    "        base = {\"Accept\": \"application/json, text/event-stream\",",
    "                \"Content-Type\": \"application/json\"}",
    "",
    "        def rpc(method, params, session=None, rid=1):",
    "            body = json.dumps({\"jsonrpc\": \"2.0\", \"id\": rid,",
    "                               \"method\": method, \"params\": params}).encode(\"utf-8\")",
    "            merged = dict(base)",
    "            merged.update(headers)",
    "            if session:",
    "                merged[\"Mcp-Session-Id\"] = session",
    "            request = urllib.request.Request(MCP_URL, data=body, method=\"POST\",",
    "                                             headers=merged)",
    "            with urllib.request.urlopen(request, timeout=30) as response:",
    "                return response.read(262144).decode(\"utf-8\", \"replace\"), \\",
    "                    response.headers.get(\"Mcp-Session-Id\")",
    "",
    "        try:",
    "            _, session = rpc(\"initialize\", {",
    "                \"protocolVersion\": \"2025-06-18\", \"capabilities\": {},",
    "                \"clientInfo\": {\"name\": \"extella-claude-setup\", \"version\": \"1\"}})",
    "            raw, _ = rpc(\"tools/call\",",
    "                         {\"name\": \"list_profiles\", \"arguments\": {}},",
    "                         session=session, rid=2)",
    "        except Exception:",
    "            return \"inconclusive\"",
    "        # Parse the envelope instead of scanning for substrings: the account",
    "        # payload legitimately contains the word \"error\" inside agent data, and",
    "        # a naive scan reported a working connection as unauthorised.",
    "        payload = None",
    "        for line in raw.splitlines():",
    "            line = line.strip()",
    "            candidate = line[5:].strip() if line.startswith(\"data:\") else line",
    "            if not candidate.startswith(\"{\"):",
    "                continue",
    "            try:",
    "                parsed = json.loads(candidate)",
    "            except Exception:",
    "                continue",
    "            if isinstance(parsed, dict) and parsed.get(\"jsonrpc\") == \"2.0\":",
    "                payload = parsed",
    "        # An unreadable envelope is not evidence of refusal. Saying so would",
    "        # send the owner hunting for a credential problem that may not exist.",
    "        if not isinstance(payload, dict):",
    "            return \"inconclusive\"",
    "        outcome = payload.get(\"result\")",
    "        if \"error\" in payload or (isinstance(outcome, dict) and outcome.get(\"isError\") is True):",
    "            return \"refused\"",
    "        return \"authorised\" if isinstance(outcome, dict) else \"inconclusive\"",
    "",
    "    # Измерено 16.08.2026: переустановка версии с архивом не разложила его на",
    "    # диск — привязка осталась от прошлой распаковки. Полагаться на то, что",
    "    # кто-то другой доставит рантайм, значит оставить кнопку сломанной там, где",
    "    # этого не произошло. Магазин отдаёт архив по имени приложения, поэтому",
    "    # этап bridge доносит его сам и делает это идемпотентно.",
    "    def fetch_and_unpack_runtime(token_value, runtime_dir):",
    "        import io, zipfile, urllib.parse",
    "        query = urllib.parse.urlencode({\"app\": APP_NAME})",
    "        request = urllib.request.Request(",
    "            STORE_BASE + \"/api/app-archive?\" + query,",
    "            headers={\"X-Extella-Token\": token_value})",
    "        try:",
    "            with urllib.request.urlopen(request, timeout=180) as response:",
    "                if response.status != 200:",
    "                    return \"download_failed\"",
    "                blob = response.read(64 * 1024 * 1024)",
    "        except Exception:",
    "            return \"download_failed\"",
    "        try:",
    "            archive = zipfile.ZipFile(io.BytesIO(blob))",
    "        except Exception:",
    "            return \"archive_invalid\"",
    "        wanted = []",
    "        for name in archive.namelist():",
    "            if name.endswith(\"/\"):",
    "                continue",
    "            # Имена из архива — данные, а не путь: абсолютный путь или \"..\",",
    "            # и распаковка пишет куда угодно за пределами каталога продукта.",
    "            if name.startswith(\"/\") or \"..\" in name.split(\"/\"):",
    "                return \"archive_unsafe\"",
    "            if name.startswith(\"scripts/\") or name.startswith(\"schemas/\") or name == \"install.py\":",
    "                wanted.append(name)",
    "        if not any(n.startswith(\"scripts/\") for n in wanted):",
    "            return \"archive_incomplete\"",
    "        try:",
    "            for name in wanted:",
    "                target = os.path.join(runtime_dir, name)",
    "                os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)",
    "                with archive.open(name) as source:",
    "                    data = source.read()",
    "                descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)",
    "                with os.fdopen(descriptor, \"wb\") as stream:",
    "                    stream.write(data)",
    "        except Exception:",
    "            return \"unpack_failed\"",
    "        return \"\"",
    "",
    "    def handle_for(value):",
    "        import hashlib",
    "        digest = hashlib.sha256((\"extella-mcp-account-v1.\" + value).encode(\"utf-8\")).hexdigest()",
    "        return \"acct_\" + digest[:12]",
    "",
    "    claude = find(\"claude\")",
    "    if platform.system() != \"Darwin\":",
    "        return result(\"error\", \"unsupported_os\", \"Автоматическая установка пока поддерживает только macOS.\")",
    "    if not claude:",
    "        return result(\"error\", \"claude_not_installed\", \"Claude Code не установлен на этом компьютере.\")",
    "",
    "    if action == \"preflight\":",
    "        version = run([claude, \"--version\"], timeout=20)",
    "        if not version or version.returncode != 0:",
    "            return result(\"error\", \"claude_version_check_failed\", \"Не удалось запустить Claude Code CLI.\")",
    "        status = run([claude, \"auth\", \"status\", \"--json\"], timeout=30)",
    "        if not status or status.returncode != 0:",
    "            return result(\"error\", \"claude_auth_check_failed\", \"Не удалось проверить вход в Claude Code.\")",
    "        try:",
    "            logged_in = json.loads(status.stdout or \"{}\").get(\"loggedIn\") is True",
    "        except Exception:",
    "            return result(\"error\", \"claude_auth_status_invalid\", \"Claude Code вернул неразборчивый статус входа.\")",
    "        if not logged_in:",
    "            # Never performed automatically: signing in is the owner's action.",
    "            return result(\"error\", \"claude_auth_required\",",
    "                          \"Войдите в Claude Code на этом компьютере: выполните `claude auth login`, затем повторите.\")",
    "        if not find(\"node\"):",
    "            return result(\"error\", \"system_tools_missing\", \"На компьютере не найден node.\")",
    "        return result(\"success\", \"preflight_ok\", \"Проверки пройдены.\",",
    "                      claude_version=(version.stdout or \"\").strip()[:120],",
    "                      claude_login_state=\"reported_signed_in\")",
    "",
    "    if action == \"install\":",
    "        # Плагин Claude Code — упаковочное удобство, а не рантайм. Измерено",
    "        # 15.08.2026: с полностью снесённым плагином и удалённым marketplace оба",
    "        # направления продолжают работать — MCP-соединение живо, мост отвечает.",
    "        # Направление A держится записью MCP, которую делает этап credentials;",
    "        # направление B — службой LaunchAgent, которую ставит этап bridge.",
    "        # Плагин намеренно не несёт ни mcpServers, ни userConfig: один набор",
    "        # userConfig не может представлять несколько аккаунтов.",
    "        #",
    "        # Поэтому отсутствие источника — это «не требуется», а не отказ. Иначе",
    "        # кнопка упирается в тупик на продукте, который уже работает.",
    "        source = marketplace_path if marketplace_path.startswith(\"/\") else \"\"",
    "        if not source:",
    "            return result(\"success\", \"plugin_not_required\",",
    "                          \"Плагин Claude Code не требуется: оба направления работают \"",
    "                          \"без него. Он появится как упаковка после публикации.\",",
    "                          plugin_installed=False, plugin_required=False)",
    "        if not os.path.isdir(source):",
    "            return result(\"error\", \"plugin_source_unavailable\",",
    "                          \"Указанный источник плагина Claude не найден.\")",
    "        listing = run([claude, \"plugin\", \"marketplace\", \"list\", \"--json\"], timeout=45)",
    "        if listing and listing.returncode == 0:",
    "            # Measured 2026-08-14: this command also returns a bare JSON array.",
    "            # Its entries do carry \"name\" — unlike plugin list, which has no",
    "            # such key. Reading it as {\"marketplaces\": [...]} raised on the",
    "            # list and was swallowed, so an existing source was never refreshed.",
    "            existing = marketplace_rows(listing)",
    "            if any(item.get(\"name\") == MARKETPLACE for item in existing):",
    "                run([claude, \"plugin\", \"marketplace\", \"remove\", MARKETPLACE], timeout=90)",
    "        added = run([claude, \"plugin\", \"marketplace\", \"add\", source, \"--scope\", \"user\"], timeout=180)",
    "        if not added or added.returncode != 0:",
    "            return result(\"error\", \"marketplace_add_failed\", \"Claude Code не смог добавить проверенный источник Extella.\")",
    "        installed = run([claude, \"plugin\", \"install\", PLUGIN, \"--scope\", \"user\"], timeout=180)",
    "        if not installed or installed.returncode != 0:",
    "            return result(\"error\", \"plugin_install_failed\", \"Claude Code не смог установить плагин Extella.\")",
    "        verified = run([claude, \"plugin\", \"list\", \"--json\"], timeout=60)",
    "        entry = installed_plugin(verified)",
    "        if not entry:",
    "            return result(\"error\", \"plugin_verification_failed\", \"Claude Code не подтвердил установленный плагин Extella.\")",
    "        # `version` is a commit SHA for a git-sourced plugin, so it is reported",
    "        # rather than compared against a semantic version.",
    "        return result(\"success\", \"plugin_installed\", \"Плагин Extella установлен в Claude Code.\",",
    "                      plugin_id=entry.get(\"id\"), plugin_version=str(entry.get(\"version\", \"\"))[:64],",
    "                      plugin_scope=entry.get(\"scope\"))",
    "",
    "    if action == \"credentials\":",
    "        token = token_from_disk()",
    "        if len(token) < 8:",
    "            return result(\"error\", \"extella_token_unavailable\", \"Текущий аккаунт Extella недоступен.\")",
    "        agent_id = validate_token(token)",
    "        if not agent_id:",
    "            token = \"\"",
    "            return result(\"error\", \"extella_token_invalid\", \"Токен текущего аккаунта Extella не подтверждён.\")",
    "        handle = handle_for(token)",
    "        try:",
    "            os.makedirs(MCP_DIR, mode=0o700, exist_ok=True)",
    "            os.chmod(MCP_DIR, 0o700)",
    "            token_path = os.path.join(MCP_DIR, handle + \".token\")",
    "            descriptor = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)",
    "            with os.fdopen(descriptor, \"w\") as stream:",
    "                stream.write(token)",
    "            # The helper reads the token at request time. It never receives it",
    "            # as an argument, so it appears in no process listing, and",
    "            # `claude mcp get` has no header value to print.",
    "            helper_path = os.path.join(MCP_DIR, handle + \".sh\")",
    "            descriptor = os.open(helper_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o700)",
    "            with os.fdopen(descriptor, \"w\") as stream:",
    "                stream.write(",
    "                    \"#!/bin/sh\\n\"",
    "                    \"printf '{\\\"X-Auth-Token\\\":\\\"%s\\\",\\\"X-Profile-Id\\\":\\\"default\\\",\"",
    "                    \"\\\"X-Agent-Id\\\":\\\"\" + agent_id + \"\\\"}\\\\n' \\\"$(cat \" + json.dumps(token_path) + \")\\\"\\n\")",
    "            run([\"/bin/launchctl\", \"setenv\", \"EXTELLA_API_TOKEN\", token], timeout=20)",
    "        except Exception:",
    "            token = \"\"",
    "            return result(\"error\", \"credential_setup_failed\", \"Не удалось подготовить локальные учётные данные Extella.\")",
    "        token = \"\"",
    "        server = \"extella_\" + handle",
    "        entry = json.dumps({\"type\": \"http\", \"url\": MCP_URL, \"headersHelper\": helper_path})",
    "        run([claude, \"mcp\", \"remove\", server, \"-s\", \"user\"], timeout=30)",
    "        added = run([claude, \"mcp\", \"add-json\", server, entry, \"--scope\", \"user\"], timeout=60)",
    "        if not added or added.returncode != 0:",
    "            return result(\"error\", \"mcp_connection_failed\", \"Не удалось настроить соединение Extella MCP.\")",
    "        return result(\"success\", \"credentials_configured\",",
    "                      \"Аккаунт Extella подключён отдельным соединением.\",",
    "                      mcp_server=server, account_handle=handle)",
    "",
    "    if action == \"bridge\":",
    "        # `__file__` не существует в Fython, и даже с ним каталога рядом нет:",
    "        # Expert — запись в базе. Рантайм приезжает архивом листинга и",
    "        # раскладывается установщиком в ~/extella_claude_bridge.",
    "        runtime_dir = os.path.join(HOME, \"extella_claude_bridge\")",
    "        script = os.path.join(runtime_dir, \"scripts\", \"configure-claude-bridge-macos.mjs\")",
    "        if not os.path.isfile(script):",
    "            token = token_from_disk()",
    "            if len(token) < 8:",
    "                return result(\"error\", \"extella_token_unavailable\",",
    "                              \"Текущий аккаунт Extella недоступен: рантайм не скачать.\")",
    "            problem = fetch_and_unpack_runtime(token, runtime_dir)",
    "            token = \"\"",
    "            if problem:",
    "                return result(\"error\", \"bridge_runtime_missing\",",
    "                              \"Локальная часть продукта не разложена и не скачалась. \"",
    "                              \"Переустановите приложение из магазина.\",",
    "                              runtime_dir=runtime_dir, reason=problem)",
    "        node = find(\"node\")",
    "        if not node:",
    "            return result(\"error\", \"system_tools_missing\", \"На компьютере не найден node.\")",
    "        if not os.path.isfile(script):",
    "            return result(\"error\", \"bridge_runtime_missing\",",
    "                          \"Локальная часть продукта не разложена. Переустановите приложение \"",
    "                          \"из магазина: рантайм моста приезжает архивом.\",",
    "                          runtime_dir=runtime_dir)",
    "        configured = run([node, script, \"--account-wide\",",
    "                          \"--confirm-account-scope\", \"I_UNDERSTAND_ALL_AGENTS\",",
    "                          \"--capability\", \"general-assistance\",",
    "                          \"--confirm-live-cost\", \"I_UNDERSTAND_COST\"], timeout=240)",
    "        if not configured or configured.returncode != 0:",
    "            detail = (configured.stderr or \"\").lower() if configured else \"\"",
    "            if \"unavailable\" in detail and \"port\" in detail:",
    "                return result(\"error\", \"bridge_port_unavailable\", \"Порт локального моста Claude уже занят.\")",
    "            return result(\"error\", \"bridge_setup_failed\", \"Не удалось запустить локальный мост Claude.\")",
    "        try:",
    "            payload = json.loads(configured.stdout or \"{}\")",
    "        except Exception:",
    "            payload = {}",
    "        if payload.get(\"status\") != \"configured\" or payload.get(\"provider\") != \"claude\":",
    "            return result(\"error\", \"bridge_verification_failed\", \"Локальный мост Claude не подтвердил конфигурацию.\")",
    "        return result(\"success\", \"bridge_ready\", \"Локальный мост Claude запущен.\",",
    "                      bridge_port=payload.get(\"port\"), live_enabled=True,",
    "                      authorization_scope=\"account\")",
    "",
    "    if action == \"verify\":",
    "        token = token_from_disk()",
    "        agent_id = validate_token(token) if len(token) >= 8 else None",
    "        handle = handle_for(token) if len(token) >= 8 else \"\"",
    "        token = \"\"",
    "        if not agent_id:",
    "            return result(\"error\", \"account_binding_unverified\", \"Привязка аккаунта Extella не подтверждена.\")",
    "        port_probe = run([\"/bin/launchctl\", \"getenv\", \"EXTELLA_CLAUDE_BRIDGE_PORT\"], timeout=20)",
    "        port = (port_probe.stdout or \"\").strip() if port_probe else \"\"",
    "        if not port.isdigit():",
    "            return result(\"error\", \"bridge_not_configured\", \"Локальный мост Claude не настроен.\")",
    "        try:",
    "            with urllib.request.urlopen(\"http://127.0.0.1:\" + port + \"/health\", timeout=10) as response:",
    "                health = json.loads(response.read(65536).decode(\"utf-8\"))",
    "        except Exception:",
    "            return result(\"error\", \"bridge_unreachable\", \"Локальный мост Claude не отвечает.\")",
    "        if (health.get(\"status\") != \"ok\" or health.get(\"live_enabled\") is not True or",
    "                \"claude\" not in health.get(\"providers\", []) or",
    "                \"account\" not in health.get(\"authorization_scopes\", []) or",
    "                health.get(\"default_execution_profile_id\") != \"answer-only\"):",
    "            return result(\"error\", \"bridge_verification_failed\", \"Локальный мост Claude не подтвердил режим account-wide.\")",
    "        helper_path = os.path.join(MCP_DIR, handle + \".sh\")",
    "        if not os.path.isfile(helper_path):",
    "            return result(\"error\", \"mcp_connection_missing\", \"Соединение Extella MCP не настроено.\")",
    "        probe = mcp_probe(helper_path)",
    "        if probe == \"refused\":",
    "            return result(\"error\", \"mcp_authentication_failed\",",
    "                          \"Соединение Extella MCP не проходит авторизацию.\")",
    "        if probe != \"authorised\":",
    "            return result(\"error\", \"mcp_probe_inconclusive\",",
    "                          \"Не удалось подтвердить авторизацию соединения Extella MCP.\")",
    "        listed = run([claude, \"mcp\", \"list\"], timeout=60)",
    "        # Presence only. The connected label in this output is not evidence of",
    "        # authentication; the binding above is what proves the account.",
    "        if not listed or (\"extella_\" + handle) not in (listed.stdout or \"\"):",
    "            return result(\"error\", \"mcp_connection_missing\", \"Соединение Extella MCP не найдено в Claude Code.\")",
    "        # Наличие плагина сообщается, но готовностью не считается: измерено, что",
    "        # со снесённым плагином оба направления продолжают работать.",
    "        plugin_entry = installed_plugin(run([claude, \"plugin\", \"list\", \"--json\"], timeout=60))",
    "        return result(\"success\", \"ready\", \"Claude Code подключён к Extella.\",",
    "                      plugin_installed=bool(plugin_entry), plugin_required=False,",
    "                      authorization_scope=\"account\", live_enabled=True,",
    "                      bridge_port=int(port), mcp_server=\"extella_\" + handle,",
    "                      account_binding_proved_by=\"token_validate\",",
    "                      mcp_authentication_proved_by=\"mcp_tools_call\",",
    "                      execution_policy_version=health.get(\"execution_policy_version\"),",
    "                      default_execution_profile_id=health.get(\"default_execution_profile_id\"))",
    "",
    "    # A partially failed install must be resumable rather than blindly",
    "    # repeated. This step reports which of the five are already done, reads",
    "    # only, and calls neither a model nor Extella.",
    "    if action == \"status\":",
    "        plugin_entry = installed_plugin(run([claude, \"plugin\", \"list\", \"--json\"], timeout=60))",
    "        token = token_from_disk()",
    "        handle = handle_for(token) if len(token) >= 8 else \"\"",
    "        token = \"\"",
    "        helper_path = os.path.join(MCP_DIR, handle + \".sh\")",
    "        if not os.path.isfile(helper_path):",
    "            return result(\"error\", \"mcp_connection_missing\", \"Соединение Extella MCP не настроено.\")",
    "        probe = mcp_probe(helper_path)",
    "        if probe == \"refused\":",
    "            return result(\"error\", \"mcp_authentication_failed\",",
    "                          \"Соединение Extella MCP не проходит авторизацию.\")",
    "        if probe != \"authorised\":",
    "            return result(\"error\", \"mcp_probe_inconclusive\",",
    "                          \"Не удалось подтвердить авторизацию соединения Extella MCP.\")",
    "        listed = run([claude, \"mcp\", \"list\"], timeout=60)",
    "        port_probe = run([\"/bin/launchctl\", \"getenv\", \"EXTELLA_CLAUDE_BRIDGE_PORT\"], timeout=20)",
    "        port = (port_probe.stdout or \"\").strip() if port_probe else \"\"",
    "        done = {",
    "            \"preflight\": True,",
    "            \"credentials\": bool(handle) and os.path.isfile(os.path.join(MCP_DIR, handle + \".sh\"))",
    "            and bool(listed) and (\"extella_\" + handle) in (listed.stdout or \"\"),",
    "            \"bridge\": port.isdigit(),",
    "        }",
    "        # \"verify\" is not a thing that gets done and stays done; it is a",
    "        # re-reading of the four above plus a live health check. Reporting it",
    "        # as a completed step meant reporting False even right after it had",
    "        # just returned ready, which is a status that contradicts the fact.",
    "        remaining = [step for step in (\"credentials\", \"bridge\") if not done[step]]",
    "        healthy = False",
    "        if not remaining:",
    "            try:",
    "                with urllib.request.urlopen(",
    "                        \"http://127.0.0.1:\" + port + \"/health\", timeout=10) as response:",
    "                    health = json.loads(response.read(65536).decode(\"utf-8\"))",
    "                healthy = (health.get(\"status\") == \"ok\" and",
    "                           \"claude\" in health.get(\"providers\", []))",
    "            except Exception:",
    "                healthy = False",
    "        return result(\"success\", \"status_read\", \"Состояние установки прочитано.\",",
    "                      completed=done, bridge_healthy=healthy,",
    "                      plugin_installed=bool(plugin_entry), plugin_required=False,",
    "                      resume_from=(remaining[0] if remaining else None),",
    "                      ready_to_verify=(not remaining and healthy),",
    "                      plugin_version=str((plugin_entry or {}).get(\"version\", \"\"))[:64])",
    "",
    "    return result(\"error\", \"unsupported_step\", \"Установщик получил неизвестный этап.\")"
  ].join('\n');

  function metadata() {
    return {
      expertName: EXPERT_NAME,
      expertSha256: EXPERT_SHA256,
      bridgeExpertName: ETB.claudeAccountBridge && ETB.claudeAccountBridge.name,
      bridgeExpertSha256: ETB.claudeAccountBridge && ETB.claudeAccountBridge.sha256,
      pluginVersion: PLUGIN_VERSION,
      bridgePort: BRIDGE_PORT,
      executionPolicyVersion: EXECUTION_POLICY_VERSION,
      defaultExecutionProfileId: DEFAULT_EXECUTION_PROFILE_ID,
      steps: STEPS.slice()
    };
  }

  // H17: the OS gateway wraps the core's response and the core wraps the
  // Expert's, and a Python dict arrives as a repr rather than JSON. Unwrap
  // both, refuse anything that is not the shape we expect, and never treat a
  // reply as success just because it arrived.
  function _parseRunResult(response) {
    var value = response;
    for (var depth = 0; depth < 4; depth++) {
      if (value && typeof value === 'object' && value.result !== undefined) {
        value = value.result;
        continue;
      }
      if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch (_) {
          throw new Error('Установщик вернул некорректный результат.');
        }
        continue;
      }
      break;
    }
    if (!value || typeof value !== 'object' || typeof value.status !== 'string' ||
        typeof value.code !== 'string') {
      throw new Error('Установщик ответил не той формой, которую ждёт приложение.');
    }
    // Setup must never spend the user's plan. A step claiming otherwise is a
    // failure even when it says success.
    if (value.model_called !== false || value.agent_called !== false ||
        value.paid !== false) {
      var costError = new Error('Этап установки сообщил о расходе, чего быть не должно.');
      costError.code = 'unexpected_cost';
      throw costError;
    }
    if (value.status !== 'success') {
      var error = new Error(value.message || 'Этап установки завершился ошибкой.');
      error.code = value.code || 'installer_failed';
      throw error;
    }
    return value;
  }

  function _resolveTargetScope() {
    return ETB.api.resolveAccountScope();
  }

  function _readExpertCode(response) {
    var value = response && response.result !== undefined ? response.result : response;
    return String((value && (value.expert_code || value.code)) || '');
  }

  function _provision(targetScope) {
    return ETB.api.saveExpertScoped({
      name: EXPERT_NAME,
      description: 'Pinned local installer for the Extella Claude bridge',
      code: EXPERT_CODE,
      kwargs: { action: 'preflight', marketplace_path: '' },
      cspl: 'fython',
      global: false
    }, targetScope).then(function (saved) {
      if (saved && saved.status === 'error') {
        throw new Error(saved.message || 'Не удалось подготовить локальный установщик.');
      }
      return ETB.api.getExpertScoped(EXPERT_NAME, targetScope, { global: false });
    }).then(function (readback) {
      // Written with one set of fields and read with another: compare by
      // content, or the check is always green and proves nothing.
      if (_readExpertCode(readback) !== EXPERT_CODE) {
        throw new Error('Проверка кода установщика после сохранения не прошла.');
      }
    });
  }

  function _ensureGlobalBridge() {
    var bridge = ETB.claudeAccountBridge;
    return ETB.api.getExpert(bridge.name, { global: true })
      .catch(function () { return null; })
      .then(function (response) {
        if (_readExpertCode(response) === bridge.code) return null;
        return ETB.api.saveExpert({
          name: bridge.name,
          description: bridge.description,
          code: bridge.code,
          kwargs: bridge.kwargs,
          cspl: 'fython',
          global: true
        }).then(function (saved) {
          if (saved && saved.status === 'error') {
            throw new Error(saved.message || 'Не удалось сохранить глобальный Claude Expert.');
          }
        });
      })
      .then(function () { return ETB.api.getExpert(bridge.name, { global: true }); })
      .then(function (response) {
        if (_readExpertCode(response) !== bridge.code) {
          throw new Error('Проверка глобального Claude Expert после сохранения не прошла.');
        }
      });
  }

  function _ruleRows(response) {
    var value = response && response.content ? response.content : response;
    return (value && (value.results || value.rules)) || [];
  }

  function _ensureRoutingRule() {
    return ETB.api.ruleListScoped({ global: true })
      .then(function (response) {
        var existing = _ruleRows(response).filter(function (row) {
          return String((row && row.rule) || '').indexOf(ROUTING_RULE_MARKER + ':') === 0;
        })[0] || null;
        if (existing && String(existing.rule) === ROUTING_RULE_TEXT) return null;
        if (existing && (existing.id != null || existing.rule_id != null)) {
          return ETB.api.ruleUpdateScoped(
            existing.id != null ? existing.id : existing.rule_id,
            ROUTING_RULE_TEXT, {});
        }
        return ETB.api.ruleAddScoped(ROUTING_RULE_TEXT, { global: true });
      })
      .then(function () { return ETB.api.ruleListScoped({ global: true }); })
      .then(function (response) {
        var found = _ruleRows(response).some(function (row) {
          return String((row && row.rule) || '') === ROUTING_RULE_TEXT;
        });
        if (!found) throw new Error('Проверка глобального правила вызова Claude не прошла.');
      });
  }

  // Подключение Expert в agent.tools удалено намеренно.
  //
  // Замер: строка в agent.tools сохраняется и читается обратно, но моделью не
  // видна — у проверенных чат-агентов нет ни Claude-моста, ни Codex-моста в
  // списке функций, хотя оба лежат в tools. Значит проверка установщика
  // «строка появилась в agent.tools» доказывала сохранение конфигурации и
  // выдавала это за доступность функции. Это ложная зелень, и лучше не делать
  // шаг вовсе, чем делать его и отчитываться об успехе.
  //
  // Рабочий путь — run_expert через системный Extella MCP, он же описан в
  // правиле. Шаг вернётся, если у платформы появится настоящий Expert-tool
  // adapter, публикующий function schema.

  function _runStep(targetScope, step, marketplacePath) {
    var long = LONG_STEPS[step] === true;
    return ETB.api.runExpertScoped(
      EXPERT_NAME,
      { action: step, marketplace_path: marketplacePath || '' },
      { global: false, wait: true, timeout: long ? 360 : 120 },
      targetScope,
      { timeoutMs: long ? 420000 : 150000 }
    ).then(_parseRunResult).catch(function (error) {
      if (error && typeof error === 'object') {
        error.installStage = step;
      }
      throw error;
    });
  }

  // Reads which steps are already done so a retry after a failure continues
  // from the gap instead of repeating work. Proven on a host left half
  // installed by an uninstall: status named the missing step and only that
  // step had to run.
  function installState(targetScope) {
    return _runStep(targetScope, 'status', '')
      .then(function (value) {
        return {
          completed: value.completed || {},
          resumeFrom: value.resume_from || null,
          readyToVerify: value.ready_to_verify === true,
          bridgeHealthy: value.bridge_healthy === true,
          pluginVersion: value.plugin_version || ''
        };
      })
      .catch(function (error) {
        // An unreadable state is not the same as a fresh host. Answering
        // STEPS[0] here meant a transient failure silently re-ran install,
        // credentials, and bridge on a machine where all three were already
        // done — the blind repetition this path exists to prevent.
        return { completed: {}, resumeFrom: null, readyToVerify: false,
                 bridgeHealthy: false, pluginVersion: '', unknown: true,
                 reason: (error && error.code) || 'status_unavailable' };
      });
  }

  function _writeConnectionState(result) {
    return ETB.api.kvSet(STATE_KEY, JSON.stringify({
      schema_version: '1.0',
      enabled: true,
      scope: 'account',
      provider: 'claude',
      capability: 'general-assistance',
      plugin_version: PLUGIN_VERSION,
      expert_name: EXPERT_NAME,
      expert_sha256: EXPERT_SHA256,
      routing_rule_marker: ROUTING_RULE_MARKER,
      bridge_port: result.bridge_port || BRIDGE_PORT,
      account_binding_proved_by: result.account_binding_proved_by || '',
      mcp_authentication_proved_by: result.mcp_authentication_proved_by || '',
      execution_policy_version: EXECUTION_POLICY_VERSION,
      default_execution_profile_id: DEFAULT_EXECUTION_PROFILE_ID,
      updated_at: new Date().toISOString()
    }), 'Account-wide Claude connection state', { global: true });
  }

  function _readConnectionState() {
    return ETB.api.kvGet(STATE_KEY, { global: true }).then(function (response) {
      var value = response && response.value !== undefined ? response.value : response;
      if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch (_) { return null; }
      }
      return value && value.enabled === true ? value : null;
    }).catch(function () { return null; });
  }

  function connectionStatus() {
    return _readConnectionState().then(function (state) {
      // Connectivity is not the question. The stored proofs are: a binding
      // confirmed by token validation and a connection confirmed by a real
      // MCP tool call. An MCP initialize answers alike with a valid token,
      // no token, and a wrong one, so it can never stand in for either.
      var connected = !!state &&
        state.scope === 'account' &&
        state.provider === 'claude' &&
        state.plugin_version === PLUGIN_VERSION &&
        state.expert_sha256 === EXPERT_SHA256 &&
        state.account_binding_proved_by === 'token_validate' &&
        state.mcp_authentication_proved_by === 'mcp_tools_call' &&
        state.execution_policy_version === EXECUTION_POLICY_VERSION &&
        state.default_execution_profile_id === DEFAULT_EXECUTION_PROFILE_ID;
      return {
        connected: connected,
        needsUpdate: !!state && !connected,
        scope: state && state.scope,
        provider: state && state.provider,
        pluginVersion: state && state.plugin_version,
        bridgePort: state && state.bridge_port,
        executionPolicyVersion: state && state.execution_policy_version,
        defaultExecutionProfileId: state && state.default_execution_profile_id
      };
    });
  }

  function install(options) {
    options = options || {};
    var progress = options.onProgress || function () {};
    var marketplacePath = options.marketplacePath || '';
    if (_running) {
      var busy = new Error('Подключение Claude уже выполняется.');
      busy.code = 'already_running';
      return Promise.reject(busy);
    }
    _running = true;
    var targetScope;
    var pending = STEPS.slice();

    return _resolveTargetScope()
      .then(function (scope) {
        targetScope = scope;
        progress({ stage: 'provisioning', metadata: metadata() });
        return _provision(targetScope);
      })
      .then(function () { return installState(targetScope); })
      .then(function (state) {
        // Resume rather than repeat. A fresh host reports the first step; a
        // half-installed one reports the gap.
        if (state.unknown && options.forceFullInstall !== true) {
          var unknownError = new Error(
            'Не удалось прочитать состояние установки. ' +
            'Повторите позже или запустите установку заново явным решением.');
          unknownError.code = 'install_state_unknown';
          unknownError.reason = state.reason;
          throw unknownError;
        }
        if (state.resumeFrom && STEPS.indexOf(state.resumeFrom) > 0) {
          pending = STEPS.slice(STEPS.indexOf(state.resumeFrom));
        }
        progress({ stage: 'resume', resumeFrom: pending[0], completed: state.completed });
        return pending.reduce(function (chain, step) {
          return chain.then(function () {
            progress({ stage: step, metadata: metadata() });
            return _runStep(targetScope, step, marketplacePath);
          });
        }, Promise.resolve());
      })
      .then(function (verified) {
        progress({ stage: 'agents', metadata: metadata() });
        return _ensureGlobalBridge()
          .then(_ensureRoutingRule)
          .then(function () { return _writeConnectionState(verified || {}); })
          .then(function () { return verified; });
      })
      .then(function (verified) {
        progress({ stage: 'done', metadata: metadata() });
        return {
          status: 'success',
          code: 'ready',
          pluginVersion: PLUGIN_VERSION,
          bridgePort: (verified && verified.bridge_port) || BRIDGE_PORT,
          authorizationScope: verified && verified.authorization_scope,
          accountBindingProvedBy: verified && verified.account_binding_proved_by,
          mcpAuthenticationProvedBy: verified && verified.mcp_authentication_proved_by,
          executionPolicyVersion: verified && verified.execution_policy_version,
          defaultExecutionProfileId: verified && verified.default_execution_profile_id,
          modelCalled: false,
          agentCalled: false,
          paid: false,
          metadata: metadata()
        };
      })
      .finally(function () { _running = false; });
  }

  return {
    install: install,
    installState: installState,
    connectionStatus: connectionStatus,
    metadata: metadata,
    expertCode: function () { return EXPERT_CODE; },
    routingRuleText: function () { return ROUTING_RULE_TEXT; },
    steps: function () { return STEPS.slice(); }
  };
})();
