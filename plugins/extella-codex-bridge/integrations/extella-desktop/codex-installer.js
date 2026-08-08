// ── CODEX CONNECTOR INSTALLER ──────────────────────────────────────────────
// Trusted host-side installer used only by the dedicated Codex button in the
// Extella storefront. The iframe never supplies an Expert name, shell command,
// repository, ref, credential, or target device. Every mutable value below is
// pinned in this signed toolbar release.

ETB.codexInstaller = (function () {
  var EXPERT_NAME = '_etb_codex_setup_v2';
  var EXPERT_SHA256 = '1e836771f0f35e30ab070a095dfffaa15454cffb72b0f277a343294846ac368c';
  var HEALTH_EXPERT_NAME = '_etb_codex_host_health_v1';
  var HEALTH_EXPERT_SHA256 = '445d111131ef27784d39fe5a665cd86f209a6624984beb6431f19c5af36abbc5';
  var INSTALL_EXPERT_NAME = 'extella_codex_plugin_install_v1';
  var INSTALL_EXPERT_SHA256 = 'bf06cdff1e1e0ffed0c7773980b6b8438f7d87ab6915f45688bf24b41d2a7dd7';
  var CREDENTIALS_EXPERT_NAME = 'extella_codex_credentials_v1';
  var CREDENTIALS_EXPERT_SHA256 = 'cd3d10475328dd915aa6504642f366c7d891846fb9450c237bd3ffcbd49dc586';
  var BRIDGE_EXPERT_NAME = 'extella_codex_bridge_setup_v1';
  var BRIDGE_EXPERT_SHA256 = 'a74575f913b69fc5ce9fc3b9449f08502548ecaf9b37dbdc7b114fb21b4bb307';
  var VERIFY_EXPERT_NAME = 'extella_codex_verify_v1';
  var VERIFY_EXPERT_SHA256 = '7704e92909e040c6c26bc3d07a19cc4b85ac347b952891b0f9e0671e86997236';
  var PLUGIN_VERSION = '0.2.1';
  var STANDARDS_REF = 'v0.2.1';
  var STATE_KEY = 'extella:codex-connection:v2';
  var ROUTING_RULE_MARKER = 'EXTELLA_CODEX_ROUTING_V3';
  var ROUTING_RULE_TEXT = ROUTING_RULE_MARKER +
    ': Codex mode is inactive by default. A one-off request to call or consult Codex ' +
    'must call Codex once and must not activate continuous mode. When the user explicitly ' +
    'asks to start, enter, or switch to a continuous Codex dialogue, call Codex and, after ' +
    'a successful call, treat Codex mode as active in this Extella chat. While Codex mode ' +
    'is active, route every later user message directly to Codex without requiring the ' +
    'user to mention Codex again, always reusing the conversation_id returned in this ' +
    'same chat. When the user asks to stop, exit, or return from Codex mode, do not send ' +
    'that command to Codex; deactivate the mode and reply locally. If no conversation_id ' +
    'exists in this chat, omit it so the bridge creates a new Codex thread. Never reuse a ' +
    'conversation_id from another chat and never summarize or truncate the Codex thread ' +
    'history. For every bridge call, use extella_codex_account_bridge_v2 directly when ' +
    'available; otherwise call run_expert with name="extella_codex_account_bridge_v2", ' +
    'global=true, and params containing prompt and the current conversation_id. Never use ' +
    'run_agent, never start another Extella agent, and do not call get_expert or ' +
    'search_experts first. Do not call Codex unless the user explicitly asks or Codex mode ' +
    'is already active in this chat.';
  // Setup is stored in the stock Qwen scope. Device choice belongs to Extella's
  // default-target resolver at run time, not to expert storage.
  var QWEN_SETUP_SCOPE = 'agent_extella_alibaba_default';
  var _running = false;
  var _fleetRunning = false;

  var EXPERT_CODE = [
    'def _etb_codex_setup_v2(step="preflight") -> str:',
    '    import json, os, platform, secrets, shutil, subprocess, urllib.request',
    '    BUILDER_REPO = "https://github.com/AnvarBakiyev/extella-codex-bridge.git"',
    '    BUILDER_REF = "v0.2.1"',
    '    STANDARDS_REF = "v0.2.1"',
    '    MARKETPLACE = "extella-codex"',
    '    PLUGIN = "extella-codex-bridge@extella-codex"',
    '',
    '    def result(status, code, message, **extra):',
    '        payload = {"status": status, "code": code, "message": message,',
    '                   "step": step, "model_called": False,',
    '                   "agent_called": False, "paid": False}',
    '        payload.update(extra)',
    '        return json.dumps(payload, ensure_ascii=False)',
    '',
    '    def find_command(name):',
    '        found = shutil.which(name)',
    '        if found:',
    '            return found',
    '        home = os.path.expanduser("~")',
    '        for root in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",',
    '                     os.path.join(home, ".local", "bin"),',
    '                     os.path.join(home, ".npm-global", "bin")]:',
    '            candidate = os.path.join(root, name)',
    '            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):',
    '                return candidate',
    '        return ""',
    '',
    '    def safe_env():',
    '        env = dict(os.environ)',
    '        home = os.path.expanduser("~")',
    '        cli_dirs = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",',
    '                    os.path.join(home, ".local", "bin"),',
    '                    os.path.join(home, ".npm-global", "bin")]',
    '        env["PATH"] = ":".join(cli_dirs + [env.get("PATH", "")])',
    '        env["GIT_TERMINAL_PROMPT"] = "0"',
    '        env["GH_PROMPT_DISABLED"] = "1"',
    '        for key in ["EXTELLA_API_TOKEN", "EXTELLA_SECONDARY_API_TOKEN",',
    '                    "EXTELLA_BRIDGE_SECRET", "OPENAI_API_KEY", "CODEX_API_KEY"]:',
    '            env.pop(key, None)',
    '        return env',
    '',
    '    def run(args, timeout=120, allow_failure=False):',
    '        try:',
    '            completed = subprocess.run(args, stdout=subprocess.PIPE,',
    '                stderr=subprocess.PIPE, text=True, timeout=timeout,',
    '                env=safe_env(), shell=False)',
    '        except subprocess.TimeoutExpired:',
    '            if allow_failure:',
    '                return None',
    '            raise RuntimeError("command_timeout")',
    '        except Exception:',
    '            if allow_failure:',
    '                return None',
    '            raise RuntimeError("command_failed")',
    '        if completed.returncode != 0:',
    '            if allow_failure:',
    '                return None',
    '            raise RuntimeError("command_exit_" + str(completed.returncode))',
    '        return completed.stdout or ""',
    '',
    '    def current_token():',
    '        try:',
    '            from extella_expert_bridge import account_config',
    '            token = str(account_config().get("auth_token", "") or "").strip()',
    '        except Exception:',
    '            token = ""',
    '        return token',
    '',
    '    def validate_token(token):',
    '        if len(token) < 8:',
    '            return False',
    '        body = json.dumps({"token": token}).encode("utf-8")',
    '        request = urllib.request.Request(',
    '            "https://api.extella.ai/api/token/validate", data=body,',
    '            headers={"Content-Type": "application/json"}, method="POST")',
    '        try:',
    '            with urllib.request.urlopen(request, timeout=15) as response:',
    '                if response.status < 200 or response.status >= 300:',
    '                    return False',
    '                payload = json.loads(response.read(65537).decode("utf-8"))',
    '                return payload.get("valid") is True',
    '        except Exception:',
    '            return False',
    '',
    '    def parse_json(text):',
    '        try:',
    '            return json.loads(text)',
    '        except Exception:',
    '            return None',
    '',
    '    def installed_plugin():',
    '        listing = parse_json(run([codex, "plugin", "list", "--json"],',
    '            timeout=60)) or {}',
    '        for item in listing.get("installed", []):',
    '            if (item.get("pluginId") == PLUGIN and',
    '                    item.get("installed") is True and',
    '                    item.get("enabled") is True and',
    '                    item.get("version") == BUILDER_REF[1:]):',
    '                source = item.get("source") or {}',
    '                path = str(source.get("path", "") or "")',
    '                if os.path.isabs(path):',
    '                    return item, path',
    '        return None, ""',
    '',
    '    if platform.system() != "Darwin":',
    '        return result("error", "unsupported_os",',
    '            "Автоматическая установка пока поддерживает только macOS.")',
    '',
    '    codex = find_command("codex")',
    '    git = find_command("git")',
    '    launchctl = find_command("launchctl")',
    '    node = find_command("node")',
    '    if not codex:',
    '        return result("error", "codex_not_installed",',
    '            "Codex не установлен на этом компьютере.")',
    '    if not git or not launchctl or not node:',
    '        return result("error", "system_tools_missing",',
    '            "На компьютере не найдены системные инструменты git, node или launchctl.")',
    '',
    '    if step == "preflight":',
    '        # Preflight is deliberately local and side-effect-free. Extella',
    '        # account credentials are not required until the later credentials',
    '        # step, where they are installed into the local bridge environment.',
    '        try:',
    '            version = run([codex, "--version"], timeout=20).strip()[:120]',
    '            run([codex, "login", "status"], timeout=30)',
    '        except Exception:',
    '            return result("error", "codex_not_ready",',
    '                "Codex найден, но вход в аккаунт не подтверждён.")',
    '        return result("success", "preflight_ok", "Проверки пройдены.",',
    '            codex_version=version, builder_ref=BUILDER_REF,',
    '            standards_ref=STANDARDS_REF)',
    '',
    '    if step == "install":',
    '        try:',
    '            listing = parse_json(run([codex, "plugin", "marketplace",',
    '                "list", "--json"], timeout=45)) or {}',
    '            exists = any(item.get("name") == MARKETPLACE',
    '                for item in listing.get("marketplaces", []))',
    '            if exists:',
    '                run([codex, "plugin", "marketplace", "remove", MARKETPLACE,',
    '                    "--json"], timeout=90)',
    '            run([codex, "plugin", "marketplace", "add",',
    '                "AnvarBakiyev/extella-codex-bridge", "--ref", BUILDER_REF,',
    '                "--json"], timeout=180)',
    '            run([codex, "plugin", "add", PLUGIN, "--json"], timeout=180)',
    '        except Exception:',
    '            return result("error", "plugin_install_failed",',
    '                "Не удалось установить Extella Codex Bridge. Можно безопасно повторить.")',
    '        return result("success", "plugin_installed",',
    '            "Extella Codex Bridge установлен.", plugin_version="0.2.1")',
    '',
    '    if step == "credentials":',
    '        token = current_token()',
    '        if not validate_token(token):',
    '            return result("error", "extella_token_unavailable",',
    '                "Не удалось подтвердить токен текущего аккаунта Extella.")',
    '        try:',
    '            run([launchctl, "setenv", "EXTELLA_API_TOKEN", token], timeout=20)',
    '            existing = run([launchctl, "getenv", "EXTELLA_BRIDGE_SECRET"],',
    '                timeout=20, allow_failure=True) or ""',
    '            if len(existing.strip()) < 32:',
    '                bridge_secret = secrets.token_hex(32)',
    '                run([launchctl, "setenv", "EXTELLA_BRIDGE_SECRET",',
    '                    bridge_secret], timeout=20)',
    '                bridge_secret = ""',
    '        except Exception:',
    '            return result("error", "credential_setup_failed",',
    '                "Не удалось подключить локальные переменные Extella к Codex.")',
    '        token = ""',
    '        return result("success", "credentials_configured",',
    '            "Аккаунт Extella подключён локально.")',
    '',
    '    if step == "bridge":',
    '        try:',
    '            _, plugin_path = installed_plugin()',
    '            script = os.path.join(plugin_path, "scripts",',
    '                "configure-bridge-macos.mjs")',
    '            if not plugin_path or not os.path.isfile(script):',
    '                return result("error", "bridge_script_unavailable",',
    '                    "Не найден проверенный установщик локального моста.")',
    '            output = parse_json(run([node, script,',
    '                "--account-wide",',
    '                "--confirm-account-scope", "I_UNDERSTAND_ALL_AGENTS",',
    '                "--capability", "general-assistance",',
    '                "--provider", "codex",',
    '                "--confirm-live-cost", "I_UNDERSTAND_COST"],',
    '                timeout=180)) or {}',
    '            if (output.get("status") != "configured" or',
    '                    output.get("authorization_scope") != "account"):',
    '                raise RuntimeError("bridge_not_configured")',
    '        except Exception:',
    '            return result("error", "bridge_setup_failed",',
    '                "Не удалось запустить локальный мост Codex.")',
    '        return result("success", "bridge_ready",',
    '            "Локальный мост Codex запущен.", live_enabled=True)',
    '',
    '    if step == "verify":',
    '        try:',
    '            installed, _ = installed_plugin()',
    '            if not installed:',
    '                return result("error", "plugin_verification_failed",',
    '                    "Codex не подтвердил установленную версию Extella Codex Bridge.")',
    '            token_present = run([launchctl, "getenv", "EXTELLA_API_TOKEN"],',
    '                timeout=20, allow_failure=True) or ""',
    '            secret_present = run([launchctl, "getenv", "EXTELLA_BRIDGE_SECRET"],',
    '                timeout=20, allow_failure=True) or ""',
    '            binding = run([launchctl, "getenv",',
    '                "EXTELLA_BRIDGE_ACCOUNT_BINDING"],',
    '                timeout=20, allow_failure=True) or ""',
    '            port = run([launchctl, "getenv", "EXTELLA_BRIDGE_PORT"],',
    '                timeout=20, allow_failure=True) or "8787"',
    '            if (len(token_present.strip()) < 8 or',
    '                    len(secret_present.strip()) < 32 or',
    '                    len(binding.strip()) != 64):',
    '                return result("error", "environment_verification_failed",',
    '                    "Локальные параметры подключения не сохранились.")',
    '            with urllib.request.urlopen("http://127.0.0.1:" +',
    '                    str(int(port.strip())) + "/health", timeout=10) as response:',
    '                health = json.loads(response.read(65536).decode("utf-8"))',
    '            if (health.get("status") != "ok" or',
    '                    health.get("live_enabled") is not True or',
    '                    "codex" not in health.get("providers", []) or',
    '                    "account" not in health.get("authorization_scopes", [])):',
    '                return result("error", "bridge_verification_failed",',
    '                    "Локальный мост не подтвердил account-wide режим.")',
    '        except Exception:',
    '            return result("error", "verification_failed",',
    '                "Не удалось проверить итоговую конфигурацию Codex.")',
    '        return result("success", "ready", "Codex подключён к Extella.",',
    '            plugin_version="0.2.1", restart_required=False,',
    '            live_enabled=True, authorization_scope="account")',
    '',
    '    return result("error", "unsupported_step",',
    '        "Установщик получил неизвестный этап.")'
  ].join('\n');

  // Fython executes the full body of an Expert before entering a branch. Keep
  // the first, zero-side-effect host check deliberately small and flat: the
  // desktop runtime has proved this shape reliable, while the legacy setup
  // Expert is a large multi-stage implementation.
  var HEALTH_EXPERT_CODE = [
    'def _etb_codex_host_health_v1(action="preflight") -> str:',
    '    import json, os, platform, shutil, subprocess',
    '    if action != "preflight":',
    '        return json.dumps({"status": "error", "code": "unsupported_action", "message": "Unsupported preflight action.", "model_called": False, "agent_called": False, "paid": False})',
    '    if platform.system() != "Darwin":',
    '        return json.dumps({"status": "error", "code": "unsupported_os", "message": "Codex connection requires macOS.", "model_called": False, "agent_called": False, "paid": False})',
    '    codex = shutil.which("codex") or ""',
    '    if not codex:',
    '        for root in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]:',
    '            candidate = os.path.join(root, "codex")',
    '            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):',
    '                codex = candidate',
    '                break',
    '    if not codex:',
    '        return json.dumps({"status": "error", "code": "codex_not_installed", "message": "Codex CLI was not found on this Mac.", "model_called": False, "agent_called": False, "paid": False})',
    '    env = dict(os.environ)',
    '    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + env.get("PATH", "")',
    '    try:',
    '        version = subprocess.run([codex, "--version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=20, env=env, shell=False)',
    '    except Exception:',
    '        return json.dumps({"status": "error", "code": "codex_version_check_failed", "message": "Extella Desktop could not start Codex CLI.", "model_called": False, "agent_called": False, "paid": False})',
    '    if version.returncode != 0:',
    '        return json.dumps({"status": "error", "code": "codex_version_check_failed", "message": "Extella Desktop could not start Codex CLI.", "model_called": False, "agent_called": False, "paid": False})',
    '    try:',
    '        login = subprocess.run([codex, "login", "status"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30, env=env, shell=False)',
    '    except Exception:',
    '        return json.dumps({"status": "error", "code": "codex_login_check_failed", "message": "Extella Desktop could not check Codex sign-in.", "model_called": False, "agent_called": False, "paid": False})',
    '    if login.returncode != 0:',
    '        return json.dumps({"status": "error", "code": "codex_login_check_failed", "message": "Sign in to Codex on this Mac, then try again.", "model_called": False, "agent_called": False, "paid": False})',
    '    return json.dumps({"status": "success", "code": "preflight_ok", "model_called": False, "agent_called": False, "paid": False})'
  ].join('\n');

  // Marketplace installation is deliberately separate from the old
  // multi-stage Expert.  Fython has proved reliable with compact, flat
  // synchronous Experts, while the legacy implementation hangs before its
  // selected branch starts.
  var INSTALL_EXPERT_CODE = [
    'def extella_codex_plugin_install_v1(action="install") -> str:',
    '    import json, os, shutil, subprocess',
    '    if action != "install":',
    '        return json.dumps({"status": "error", "code": "unsupported_action", "message": "Unsupported installation action.", "model_called": False, "agent_called": False, "paid": False})',
    '    codex = shutil.which("codex") or "/opt/homebrew/bin/codex"',
    '    if not os.path.isfile(codex) or not os.access(codex, os.X_OK):',
    '        return json.dumps({"status": "error", "code": "codex_not_installed", "message": "Codex CLI was not found on this Mac.", "model_called": False, "agent_called": False, "paid": False})',
    '    env = dict(os.environ)',
    '    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + env.get("PATH", "")',
    '    try:',
    '        listing = subprocess.run([codex, "plugin", "marketplace", "list", "--json"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=45, env=env, shell=False)',
    '    except Exception:',
    '        return json.dumps({"status": "error", "code": "marketplace_list_failed", "message": "Codex could not inspect plugin marketplaces.", "model_called": False, "agent_called": False, "paid": False})',
    '    if listing.returncode != 0:',
    '        return json.dumps({"status": "error", "code": "marketplace_list_failed", "message": "Codex could not inspect plugin marketplaces.", "model_called": False, "agent_called": False, "paid": False})',
    '    try:',
    '        marketplaces = json.loads(listing.stdout or "{}").get("marketplaces", [])',
    '    except Exception:',
    '        return json.dumps({"status": "error", "code": "marketplace_list_invalid", "message": "Codex returned an invalid marketplace list.", "model_called": False, "agent_called": False, "paid": False})',
    '    if any(item.get("name") == "extella-codex" for item in marketplaces):',
    '        removed = subprocess.run([codex, "plugin", "marketplace", "remove", "extella-codex", "--json"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=90, env=env, shell=False)',
    '        if removed.returncode != 0:',
    '            return json.dumps({"status": "error", "code": "marketplace_remove_failed", "message": "Codex could not refresh the Extella marketplace.", "model_called": False, "agent_called": False, "paid": False})',
    '    added = subprocess.run([codex, "plugin", "marketplace", "add", "AnvarBakiyev/extella-codex-bridge", "--ref", "v0.2.1", "--json"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=180, env=env, shell=False)',
    '    if added.returncode != 0:',
    '        return json.dumps({"status": "error", "code": "marketplace_add_failed", "message": "Codex could not add the verified Extella marketplace.", "model_called": False, "agent_called": False, "paid": False})',
    '    installed = subprocess.run([codex, "plugin", "add", "extella-codex-bridge@extella-codex", "--json"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=180, env=env, shell=False)',
    '    if installed.returncode != 0:',
    '        return json.dumps({"status": "error", "code": "plugin_install_failed", "message": "Codex could not install Extella Codex Bridge.", "model_called": False, "agent_called": False, "paid": False})',
    '    return json.dumps({"status": "success", "code": "plugin_installed", "message": "Extella Codex Bridge is installed.", "plugin_version": "0.2.1", "model_called": False, "agent_called": False, "paid": False})'
  ].join('\n');

  // This performs the local, secret-preserving preparation needed by the
  // loopback bridge. It deliberately returns only a public status JSON.
  var CREDENTIALS_EXPERT_CODE = [
    'def extella_codex_credentials_v1(action="credentials") -> str:',
    '    import json, os, secrets, subprocess, urllib.request',
    '    if action != "credentials":',
    '        return json.dumps({"status": "error", "code": "unsupported_action", "message": "Unsupported credentials action.", "model_called": False, "agent_called": False, "paid": False})',
    '    token_path = os.path.join(os.path.expanduser("~"), ".extella", "api_token.txt")',
    '    try:',
    '        with open(token_path, "r", encoding="utf-8") as stream:',
    '            token = stream.read(4096).strip()',
    '    except Exception:',
    '        token = ""',
    '    if len(token) < 8:',
    '        return json.dumps({"status": "error", "code": "extella_token_unavailable", "message": "Current Extella account is unavailable.", "model_called": False, "agent_called": False, "paid": False})',
    '    try:',
    '        payload = json.dumps({"token": token}).encode("utf-8")',
    '        request = urllib.request.Request("https://api.extella.ai/api/token/validate", data=payload, headers={"Content-Type": "application/json"}, method="POST")',
    '        with urllib.request.urlopen(request, timeout=15) as response:',
    '            valid = json.loads(response.read(65537).decode("utf-8")).get("valid") is True and response.status >= 200 and response.status < 300',
    '    except Exception:',
    '        valid = False',
    '    if not valid:',
    '        token = ""',
    '        return json.dumps({"status": "error", "code": "extella_token_unavailable", "message": "Current Extella account could not be verified.", "model_called": False, "agent_called": False, "paid": False})',
    '    try:',
    '        set_token = subprocess.run(["/bin/launchctl", "setenv", "EXTELLA_API_TOKEN", token], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20, shell=False)',
    '        existing = subprocess.run(["/bin/launchctl", "getenv", "EXTELLA_BRIDGE_SECRET"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=20, shell=False)',
    '        if set_token.returncode != 0:',
    '            raise RuntimeError("set_token_failed")',
    '        if existing.returncode != 0 or len((existing.stdout or "").strip()) < 32:',
    '            secret = secrets.token_hex(32)',
    '            set_secret = subprocess.run(["/bin/launchctl", "setenv", "EXTELLA_BRIDGE_SECRET", secret], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20, shell=False)',
    '            secret = ""',
    '            if set_secret.returncode != 0:',
    '                raise RuntimeError("set_secret_failed")',
    '    except Exception:',
    '        token = ""',
    '        return json.dumps({"status": "error", "code": "credential_setup_failed", "message": "Extella Desktop could not prepare local bridge credentials.", "model_called": False, "agent_called": False, "paid": False})',
    '    token = ""',
    '    return json.dumps({"status": "success", "code": "credentials_configured", "message": "Local bridge credentials are ready.", "model_called": False, "agent_called": False, "paid": False})'
  ].join('\n');

  // Live mode has an explicit owner confirmation in the product flow. This
  // compact Expert configures only a 127.0.0.1 LaunchAgent and reports a
  // bounded status; secrets remain in launchctl and are never returned.
  var BRIDGE_EXPERT_CODE = [
    'def extella_codex_bridge_setup_v1(action="bridge") -> str:',
    '    import json, os, shutil, subprocess',
    '    if action != "bridge":',
    '        return json.dumps({"status": "error", "code": "unsupported_action", "message": "Unsupported bridge action.", "model_called": False, "agent_called": False, "paid": False})',
    '    codex = shutil.which("codex") or "/opt/homebrew/bin/codex"',
    '    node = shutil.which("node") or "/opt/homebrew/bin/node"',
    '    if not os.path.isfile(codex) or not os.access(codex, os.X_OK) or not os.path.isfile(node) or not os.access(node, os.X_OK):',
    '        return json.dumps({"status": "error", "code": "local_tools_missing", "message": "Codex CLI or Node was not found on this Mac.", "model_called": False, "agent_called": False, "paid": False})',
    '    env = dict(os.environ)',
    '    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + env.get("PATH", "")',
    '    port = 18787',
    '    try:',
    '        listing = subprocess.run([codex, "plugin", "list", "--json"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60, env=env, shell=False)',
    '    except Exception:',
    '        return json.dumps({"status": "error", "code": "plugin_list_failed", "message": "Codex could not inspect installed plugins.", "model_called": False, "agent_called": False, "paid": False})',
    '    if listing.returncode != 0:',
    '        return json.dumps({"status": "error", "code": "plugin_list_failed", "message": "Codex could not inspect installed plugins.", "model_called": False, "agent_called": False, "paid": False})',
    '    try:',
    '        installed = json.loads(listing.stdout or "{}").get("installed", [])',
    '        matches = [item for item in installed if item.get("pluginId") == "extella-codex-bridge@extella-codex" and item.get("installed") is True and item.get("enabled") is True and item.get("version") == "0.2.1"]',
    '        plugin_path = str((matches[0].get("source") or {}).get("path") or "") if matches else ""',
    '    except Exception:',
    '        plugin_path = ""',
    '    script = os.path.join(plugin_path, "scripts", "configure-bridge-macos.mjs") if os.path.isabs(plugin_path) else ""',
    '    if not script or not os.path.isfile(script):',
    '        return json.dumps({"status": "error", "code": "bridge_script_unavailable", "message": "The verified local bridge installer was not found.", "model_called": False, "agent_called": False, "paid": False})',
    '    try:',
    '        configured = subprocess.run([node, script, "--account-wide", "--confirm-account-scope", "I_UNDERSTAND_ALL_AGENTS", "--capability", "general-assistance", "--port", str(port), "--provider", "codex", "--confirm-live-cost", "I_UNDERSTAND_COST"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=240, env=env, shell=False)',
    '    except Exception:',
    '        return json.dumps({"status": "error", "code": "bridge_setup_failed", "message": "Extella Desktop could not configure the local Codex bridge.", "model_called": False, "agent_called": False, "paid": False})',
    '    if configured.returncode != 0:',
    '        detail = (configured.stderr or "").lower()',
    '        if "port 127.0.0.1:" in detail and "unavailable" in detail:',
    '            return json.dumps({"status": "error", "code": "bridge_port_unavailable", "message": "The local Codex bridge port is already in use.", "model_called": False, "agent_called": False, "paid": False})',
    '        return json.dumps({"status": "error", "code": "bridge_setup_failed", "message": "Extella Desktop could not configure the local Codex bridge.", "model_called": False, "agent_called": False, "paid": False})',
    '    try:',
    '        result = json.loads(configured.stdout or "{}")',
    '    except Exception:',
    '        result = {}',
    '    if result.get("status") != "configured" or result.get("authorization_scope") != "account" or result.get("provider") != "codex":',
    '        return json.dumps({"status": "error", "code": "bridge_verification_failed", "message": "The local Codex bridge did not verify its account-wide configuration.", "model_called": False, "agent_called": False, "paid": False})',
    '    return json.dumps({"status": "success", "code": "bridge_ready", "message": "Local live Codex bridge is ready.", "live_enabled": True, "authorization_scope": "account", "bridge_port": port, "model_called": False, "agent_called": False, "paid": False})'
  ].join('\n');

  // The final health request is intentionally independent of bridge setup.
  // Keeping it compact means a successful bridge cannot be masked by the
  // legacy background-worker behaviour of the original all-in-one Expert.
  var VERIFY_EXPERT_CODE = [
    'def extella_codex_verify_v1(action="verify") -> str:',
    '    import json, subprocess, urllib.request',
    '    if action != "verify":',
    '        return json.dumps({"status": "error", "code": "unsupported_action", "message": "Unsupported verification action.", "model_called": False, "agent_called": False, "paid": False})',
    '    try:',
    '        token = subprocess.run(["/bin/launchctl", "getenv", "EXTELLA_API_TOKEN"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=20, shell=False)',
    '        secret = subprocess.run(["/bin/launchctl", "getenv", "EXTELLA_BRIDGE_SECRET"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=20, shell=False)',
    '        binding = subprocess.run(["/bin/launchctl", "getenv", "EXTELLA_BRIDGE_ACCOUNT_BINDING"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=20, shell=False)',
    '        port = subprocess.run(["/bin/launchctl", "getenv", "EXTELLA_BRIDGE_PORT"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=20, shell=False)',
    '        token_value = (token.stdout or "").strip()',
    '        secret_value = (secret.stdout or "").strip()',
    '        binding_value = (binding.stdout or "").strip()',
    '        port_value = (port.stdout or "8787").strip() or "8787"',
    '        if len(token_value) < 8 or len(secret_value) < 32 or len(binding_value) != 64:',
    '            return json.dumps({"status": "error", "code": "environment_verification_failed", "message": "Local bridge credentials were not retained.", "model_called": False, "agent_called": False, "paid": False})',
    '        with urllib.request.urlopen("http://127.0.0.1:" + str(int(port_value)) + "/health", timeout=10) as response:',
    '            health = json.loads(response.read(65536).decode("utf-8"))',
    '    except Exception:',
    '        return json.dumps({"status": "error", "code": "verification_failed", "message": "Extella Desktop could not verify the local Codex bridge.", "model_called": False, "agent_called": False, "paid": False})',
    '    if health.get("status") != "ok" or health.get("live_enabled") is not True or "codex" not in health.get("providers", []) or "account" not in health.get("authorization_scopes", []):',
    '        return json.dumps({"status": "error", "code": "bridge_verification_failed", "message": "The local Codex bridge did not confirm account-wide live mode.", "model_called": False, "agent_called": False, "paid": False})',
    '    return json.dumps({"status": "success", "code": "ready", "message": "Codex is connected to Extella.", "plugin_version": "0.2.1", "restart_required": False, "live_enabled": True, "authorization_scope": "account", "model_called": False, "agent_called": False, "paid": False})'
  ].join('\n');

  function metadata() {
    return {
      expertName: EXPERT_NAME,
      expertSha256: EXPERT_SHA256,
      healthExpertName: HEALTH_EXPERT_NAME,
      healthExpertSha256: HEALTH_EXPERT_SHA256,
      installExpertName: INSTALL_EXPERT_NAME,
      installExpertSha256: INSTALL_EXPERT_SHA256,
      credentialsExpertName: CREDENTIALS_EXPERT_NAME,
      credentialsExpertSha256: CREDENTIALS_EXPERT_SHA256,
      bridgeSetupExpertName: BRIDGE_EXPERT_NAME,
      bridgeSetupExpertSha256: BRIDGE_EXPERT_SHA256,
      verifyExpertName: VERIFY_EXPERT_NAME,
      verifyExpertSha256: VERIFY_EXPERT_SHA256,
      bridgeExpertName: ETB.codexAccountBridge.name,
      bridgeExpertSha256: ETB.codexAccountBridge.sha256,
      pluginVersion: PLUGIN_VERSION,
      standardsRef: STANDARDS_REF
    };
  }

  function _parseRunResult(response) {
    var value = response;
    if (value && value.result !== undefined) value = value.result;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch (_) {
        throw new Error('Установщик вернул некорректный результат.');
      }
    }
    if (!value || value.status !== 'success') {
      var error = new Error((value && value.message) || 'Этап установки завершился ошибкой.');
      error.code = (value && value.code) || 'installer_failed';
      throw error;
    }
    return value;
  }

  function connectionStatus() {
    return _readConnectionState()
      .then(function (response) {
        var connected = !!response &&
          response.scope === 'account' &&
          response.provider === 'codex' &&
          response.plugin_version === PLUGIN_VERSION &&
          response.expert_name === ETB.codexAccountBridge.name &&
          response.expert_sha256 === ETB.codexAccountBridge.sha256;
        return {
          connected: connected,
          needsUpdate: !!response && !connected,
          scope: response && response.scope,
          provider: response && response.provider,
          pluginVersion: response && response.plugin_version,
          agentCount: response && response.current_agent_count
        };
      });
  }

  function _readExpertCode(response) {
    var value = response && response.result !== undefined ? response.result : response;
    return String((value && (value.expert_code || value.code)) || '');
  }

  function _agentRows(response) {
    var value = response && response.content ? response.content : response;
    return (value && Array.isArray(value.agents)) ? value.agents : [];
  }

  function _ruleRows(response) {
    var value = response && response.content ? response.content : response;
    return (value && (value.results || value.rules)) || [];
  }

  function _ruleText(row) {
    return String((row && row.rule) || '');
  }

  function _ruleId(row) {
    return row && (row.id != null ? row.id : row.rule_id);
  }

  function _resolveTargetScope() {
    // `save` scopes the Expert to an agent only. The normal `run` contract
    // resolves the account's default Extella Desktop target itself, so the
    // optional targets registry must not become a setup prerequisite.
    return Promise.resolve(QWEN_SETUP_SCOPE);
  }

  function _agentDetail(response) {
    var value = response && response.content ? response.content : response;
    return (value && value.agent) || value || {};
  }

  function _canRunGlobalExpert(tools) {
    // Extella exposes the same account-global capability in two supported
    // shapes: the short built-in tool on stock agents and the fully-qualified
    // MCP tool on user agents. Either one can invoke the global bridge Expert.
    return tools.indexOf('run_expert') !== -1 ||
      tools.indexOf('run_expert_mcp_extella') !== -1 ||
      tools.indexOf('sys__all__sys_mcp_extella') !== -1 ||
      tools.indexOf('sys__server__sys_mcp_extella') !== -1;
  }

  function _mapLimit(items, limit, worker) {
    var index = 0;
    var results = new Array(items.length);
    function runner() {
      function next() {
        var current = index++;
        if (current >= items.length) return Promise.resolve();
        return Promise.resolve(worker(items[current], current))
          .then(function (value) {
            results[current] = value;
            return next();
          });
      }
      return next();
    }
    var runners = [];
    for (var i = 0; i < Math.min(limit, items.length); i++) {
      runners.push(runner());
    }
    return Promise.all(runners).then(function () { return results; });
  }

  function _readAgentState(agent) {
    var agentId = String((agent && (agent.id || agent.agent_id)) || '');
    if (!/^agent_[A-Za-z0-9_-]{8,128}$/.test(agentId)) {
      throw new Error('Extella вернула некорректный ID агента.');
    }
    return ETB.api.agentGetScoped(agentId)
      .then(function (beforeResponse) {
        var detail = _agentDetail(beforeResponse);
        if (!Array.isArray(detail.tools)) {
          throw new Error('Extella не вернула список tools агента ' + agentId + '.');
        }
        return {
          agentId: agentId,
          beforeTools: detail.tools.map(String),
          isPublic: detail.isPublic === true || detail.is_public === true
        };
      });
  }

  function _readGlobalBridge(bridge) {
    // A global Expert belongs to the authenticated account, not to an agent
    // scope. Public stock agents may expose it only through their system MCP,
    // so a scoped get_expert is not a valid visibility check for them.
    return ETB.api.getExpert(bridge.name, { global: true })
      .catch(function () { return null; });
  }

  function _ensureGlobalBridge() {
    var bridge = ETB.codexAccountBridge;
    return _readGlobalBridge(bridge)
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
            throw new Error(saved.message || 'Не удалось сохранить глобальный Codex Expert.');
          }
        });
      })
      .then(function () { return _readGlobalBridge(bridge); })
      .then(function (response) {
        if (_readExpertCode(response) !== bridge.code) {
          throw new Error('Проверка глобального Codex Expert после сохранения не прошла.');
        }
      });
  }

  function _ensureRoutingRule() {
    var existing = null;
    return ETB.api.ruleListScoped({ global: true })
      .then(function (response) {
        existing = _ruleRows(response).filter(function (row) {
          return _ruleText(row).indexOf(ROUTING_RULE_MARKER + ':') === 0;
        })[0] || null;
        if (existing && _ruleText(existing) === ROUTING_RULE_TEXT) return null;
        if (existing && _ruleId(existing) != null) {
          return ETB.api.ruleUpdateScoped(_ruleId(existing), ROUTING_RULE_TEXT, {});
        }
        return ETB.api.ruleAddScoped(ROUTING_RULE_TEXT, { global: true });
      })
      .then(function (saved) {
        if (saved && saved.status === 'error') {
          throw new Error(saved.message || 'Не удалось сохранить правило вызова Codex.');
        }
        return ETB.api.ruleListScoped({ global: true });
      })
      .then(function (response) {
        var found = _ruleRows(response).some(function (row) {
          return _ruleText(row) === ROUTING_RULE_TEXT;
        });
        if (!found) {
          throw new Error('Проверка глобального правила вызова Codex не прошла.');
        }
      });
  }

  function _installForAgent(state) {
    var agentId = state.agentId;
    var bridge = ETB.codexAccountBridge;
    var beforeTools = state.beforeTools;
    var added = beforeTools.indexOf(bridge.name) === -1;
    var inherited = added && state.isPublic && _canRunGlobalExpert(beforeTools);
    return Promise.resolve()
      .then(function () {
        // Public stock agents are shared platform objects, so Extella correctly
        // ignores account-local tool mutations on them. They already expose the
        // system Extella MCP, which can run the fresh account-global Expert.
        if (!added || inherited) return null;
        return ETB.api.agentToolsUpdateScoped(
          agentId,
          beforeTools.concat([bridge.name])
        ).then(function (updated) {
          if (updated && updated.status === 'error') {
            throw new Error(updated.message || 'Не удалось подключить Codex к агенту.');
          }
        });
      })
      .then(function () {
        if (inherited) {
          return { agentId: agentId, added: false, inherited: true };
        }
        return ETB.api.agentGetScoped(agentId);
      })
      .then(function (readback) {
        if (readback && readback.inherited === true) return readback;
        var detail = _agentDetail(readback);
        var tools = Array.isArray(detail.tools) ? detail.tools.map(String) : [];
        if (tools.indexOf(bridge.name) === -1) {
          if (_canRunGlobalExpert(tools)) {
            return { agentId: agentId, added: false, inherited: true };
          }
          throw new Error('Extella не сохранила tool Codex у агента ' + agentId + '.');
        }
        return { agentId: agentId, added: added, inherited: false };
      });
  }

  function _writeConnectionState(agentCount, inheritedCount) {
    var value = JSON.stringify({
      schema_version: '2.0',
      enabled: true,
      scope: 'account',
      provider: 'codex',
      capability: 'general-assistance',
      plugin_version: PLUGIN_VERSION,
      expert_name: ETB.codexAccountBridge.name,
      expert_sha256: ETB.codexAccountBridge.sha256,
      routing_rule_marker: ROUTING_RULE_MARKER,
      current_agent_count: agentCount,
      system_mcp_agent_count: inheritedCount,
      reconcile_future_agents: true,
      updated_at: new Date().toISOString()
    });
    return ETB.api.kvSet(
      STATE_KEY,
      value,
      'Account-wide Codex connection state',
      { global: true }
    );
  }

  function _readConnectionState() {
    return ETB.api.kvGet(STATE_KEY, { global: true }).then(function (response) {
      var value = response && response.value !== undefined ?
        response.value : response;
      if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch (_) { return null; }
      }
      return value && value.enabled === true ? value : null;
    }).catch(function () { return null; });
  }

  function reconcileFleet(options) {
    options = options || {};
    if (_fleetRunning) return Promise.resolve({ status: 'busy' });
    _fleetRunning = true;
    var rows = [];
    var states = [];
    return ETB.api.agentsList()
      .then(function (response) {
        rows = _agentRows(response);
        if (!rows.length) throw new Error('В аккаунте Extella не найдены агенты.');
        // Read every agent before the first write. A partial fleet must never be
        // reported as connected when one agent cannot even be inspected.
        return _mapLimit(rows, 3, _readAgentState);
      })
      .then(function (readStates) {
        states = readStates;
        return _ensureGlobalBridge();
      })
      .then(function () {
        return _ensureRoutingRule();
      })
      .then(function () {
        return _mapLimit(states, 3, _installForAgent);
      })
      .then(function (receipts) {
        var inheritedCount = receipts.filter(function (item) {
          return item && item.inherited;
        }).length;
        return _writeConnectionState(rows.length, inheritedCount).then(function () {
          return {
            status: 'ready',
            agentCount: rows.length,
            addedCount: receipts.filter(function (item) {
              return item && item.added;
            }).length,
            inheritedCount: inheritedCount,
            expertSha256: ETB.codexAccountBridge.sha256
          };
        });
      })
      .finally(function () { _fleetRunning = false; });
  }

  function _startAutoReconcile() {
    if (typeof setTimeout !== 'function' || !ETB.api) return;
    function tick() {
      _readConnectionState().then(function (state) {
        if (!state ||
            state.expert_sha256 !== ETB.codexAccountBridge.sha256 ||
            state.plugin_version !== PLUGIN_VERSION) return;
        reconcileFleet({ automatic: true }).catch(function () {});
      });
    }
    setTimeout(tick, 10000);
    if (typeof setInterval === 'function') setInterval(tick, 120000);
  }

  function _provision(targetScope) {
    function saveAndRead(name, description, code) {
      return ETB.api.saveExpertScoped({
        name: name,
        description: description,
        code: code,
        kwargs: {},
        cspl: 'fython',
        global: false
      }, targetScope).then(function (saved) {
        if (saved && saved.status === 'error') {
          throw new Error(saved.message || 'Не удалось подготовить локальный установщик.');
        }
        return ETB.api.getExpertScoped(name, targetScope, { global: false });
      }).then(function (readback) {
        if (_readExpertCode(readback) !== code) {
          throw new Error('Проверка кода установщика после сохранения не прошла.');
        }
      });
    }
    return saveAndRead(
      HEALTH_EXPERT_NAME,
      'Pinned compact Codex host preflight for Extella',
      HEALTH_EXPERT_CODE
    ).then(function () {
      return saveAndRead(
        INSTALL_EXPERT_NAME,
        'Pinned compact Codex plugin installer for Extella',
        INSTALL_EXPERT_CODE
      );
    }).then(function () {
      return saveAndRead(
        BRIDGE_EXPERT_NAME,
        'Pinned compact live Codex bridge setup for Extella',
        BRIDGE_EXPERT_CODE
      );
    }).then(function () {
      return saveAndRead(
        CREDENTIALS_EXPERT_NAME,
        'Pinned compact local credentials setup for Extella Codex bridge',
        CREDENTIALS_EXPERT_CODE
      );
    }).then(function () {
      return saveAndRead(
        VERIFY_EXPERT_NAME,
        'Pinned compact live Codex bridge verification for Extella',
        VERIFY_EXPERT_CODE
      );
    }).then(function () {
      return saveAndRead(
        EXPERT_NAME,
        'Pinned local installer for Extella Codex Bridge',
        EXPERT_CODE
      );
    });
  }

  function _runStep(targetScope, step) {
    var longStep = step === 'install' || step === 'bridge';
    var expertName = step === 'preflight' ? HEALTH_EXPERT_NAME :
      (step === 'install' ? INSTALL_EXPERT_NAME :
        (step === 'credentials' ? CREDENTIALS_EXPERT_NAME :
          (step === 'bridge' ? BRIDGE_EXPERT_NAME :
            (step === 'verify' ? VERIFY_EXPERT_NAME : EXPERT_NAME))));
    // A compact Fython health check completes in a few seconds.  Running this
    // one step synchronously avoids the desktop background-worker path, which
    // has reported a false "Worker hung" before user code begins.
    if (step === 'preflight' || step === 'install' || step === 'credentials' || step === 'bridge' || step === 'verify') {
      return ETB.api.runExpertScoped(
        expertName,
        { action: step },
        { global: false, wait: true, timeout: longStep ? 360 : 120 },
        targetScope,
        { timeoutMs: longStep ? 420000 : 150000 }
      ).then(_parseRunResult).catch(function (error) {
        if (error && typeof error === 'object') {
          error.installStage = step;
          error.targetScope = targetScope;
        }
        throw error;
      });
    }
    return ETB.api.runExpertAsyncScoped(
      expertName,
      { step: step },
      {
        global: false,
        timeout: longStep ? 360 : 120,
        maxWait: longStep ? 420000 : 180000,
        interval: 1500,
        stallTimeout: 0
      },
      targetScope
    ).then(_parseRunResult).catch(function (error) {
      if (error && typeof error === 'object') {
        error.installStage = step;
        error.targetScope = targetScope;
      }
      throw error;
    });
  }

  function install(options) {
    options = options || {};
    var progress = options.onProgress || function () {};
    if (_running) {
      var busy = new Error('Подключение Codex уже выполняется.');
      busy.code = 'already_running';
      return Promise.reject(busy);
    }
    _running = true;
    var targetScope;
    var finalResult;
    return _resolveTargetScope()
      .then(function (resolvedScope) {
        targetScope = resolvedScope;
        progress({ stage: 'provisioning', metadata: metadata() });
        return _provision(targetScope);
      })
      .then(function () {
        progress({ stage: 'preflight', metadata: metadata() });
        return _runStep(targetScope, 'preflight');
      })
      .then(function () {
        progress({ stage: 'install', metadata: metadata() });
        return _runStep(targetScope, 'install');
      })
      .then(function () {
        progress({ stage: 'credentials', metadata: metadata() });
        return _runStep(targetScope, 'credentials');
      })
      .then(function () {
        progress({ stage: 'bridge', metadata: metadata() });
        return _runStep(targetScope, 'bridge');
      })
      .then(function () {
        progress({ stage: 'agents', metadata: metadata() });
        return reconcileFleet();
      })
      .then(function (fleet) {
        progress({ stage: 'verify', metadata: metadata() });
        return _runStep(targetScope, 'verify').then(function (result) {
          result.fleet = fleet;
          return result;
        });
      })
      .then(function (result) {
        finalResult = result;
        progress({ stage: 'done', metadata: metadata() });
        return {
          status: 'success',
          code: 'ready',
          pluginVersion: result.plugin_version || PLUGIN_VERSION,
          restartRequired: result.restart_required === true,
          liveEnabled: result.live_enabled === true,
          authorizationScope: result.authorization_scope,
          agentCount: result.fleet && result.fleet.agentCount,
          modelCalled: false,
          agentCalled: false,
          paid: false,
          metadata: metadata()
        };
      })
      .finally(function () {
        _running = false;
        finalResult = null;
      });
  }

  _startAutoReconcile();
  return {
    install: install,
    reconcileFleet: reconcileFleet,
    connectionStatus: connectionStatus,
    metadata: metadata,
    expertCode: function () { return EXPERT_CODE; },
    healthExpertCode: function () { return HEALTH_EXPERT_CODE; },
    installExpertCode: function () { return INSTALL_EXPERT_CODE; },
    credentialsExpertCode: function () { return CREDENTIALS_EXPERT_CODE; },
    bridgeSetupExpertCode: function () { return BRIDGE_EXPERT_CODE; },
    verifyExpertCode: function () { return VERIFY_EXPERT_CODE; },
    bridgeExpertCode: function () { return ETB.codexAccountBridge.code; }
  };
})();
