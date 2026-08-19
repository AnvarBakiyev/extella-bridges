// ── MARKETPLACE PANEL ─────────────────────────────────────────────────────
// Opens the plugins_manager.html in a full-screen modal overlay (iframe).
// Exposes: ETB.marketplace.open(), ETB.marketplace.close()

ETB.marketplace = (function () {
  var _msgHandler = null;
  var _blobUrl = null;

  // Full removal of an agent-installed plugin: delete every artifact the agent
  // created (experts, KV keys, on-device files + running server, registry file)
  // plus the local registry entry. Driven by the manifest's `artifacts`, with
  // safe deterministic fallbacks when the manifest is missing. Fire-and-forget —
  // cleanup errors must never surface in the UI.
  function _removeAgentPlugin(pluginId, plugin) {
    plugin = plugin || ETB.registry.getById(pluginId);
    var safeId = pluginId.replace(/[^a-z0-9]/gi, '_');
    var art = (plugin && plugin.artifacts) || {};

    var rootPath = art.rootPath || (plugin && plugin.ui && plugin.ui.rootPath) || ('~/extella-plugins/' + safeId);
    var registryFile = art.registryFile || ('~/extella-plugins/_registry/' + safeId + '.json');

    // Collect every pid file the agent may have written (static server + real
    // service), deduped, so Remove tears the running app down too.
    var pidFiles = [];
    function _addPid(p) { if (p && pidFiles.indexOf(p) === -1) pidFiles.push(p); }
    _addPid(art.pidFile);
    (art.pidFiles || []).forEach(_addPid);
    if (plugin && plugin.service && plugin.service.pidFile) _addPid(plugin.service.pidFile);
    _addPid('/tmp/etb_srv_' + safeId + '.pid');
    var pidListPy = '[' + pidFiles.map(function (p) {
      return '"' + String(p).replace(/"/g, '\\"') + '"';
    }).join(', ') + ']';

    // 1) Delete saved experts (start expert + any plugin experts). Include the
    //    start expert from ui as a fallback when artifacts is incomplete.
    var experts = (art.experts || []).slice();
    if (plugin && plugin.ui && plugin.ui.startExpert && experts.indexOf(plugin.ui.startExpert) === -1) {
      experts.push(plugin.ui.startExpert);
    }
    (plugin && plugin.experts ? plugin.experts : []).forEach(function (name) {
      if (typeof name === 'string' && experts.indexOf(name) === -1) experts.push(name);
    });
    experts.forEach(function (name) {
      if (name) ETB.api.deleteExpert(name).catch(function () {});
    });

    // 2) Clear KV keys (declared + legacy server-port key).
    (art.kvKeys || []).forEach(function (k) {
      if (k) ETB.api.kvSet(k, '').catch(function () {});
    });
    ETB.api.kvSet('_server_port_' + safeId, '').catch(function () {});

    // 3) On-device cleanup: stop server, remove files, build status, registry file.
    var fnName = '_etb_cleanup_' + safeId;
    var code = [
      'def ' + fnName + '() -> str:',
      '    import os, signal, shutil, json, glob',
      '    removed = []',
      // Windows: каталога /tmp нет. Переносим путь на системный временный ТОЛЬКО там, где
      // /tmp действительно отсутствует — на macOS и Linux поведение не меняется ни на байт,
      // иначе писатель и читатель pid-файла разъедутся и процессы останутся сиротами.
      '    import tempfile',
      '    def _tmp_path(p):',
      '        return p if os.path.isdir("/tmp") or not p.startswith("/tmp/") else \\',
      '            os.path.join(tempfile.gettempdir(), p[len("/tmp/"):])',
      '    for pid_file in [_tmp_path(x) for x in ' + pidListPy + ']:',
      '        if os.path.exists(pid_file):',
      '            try: os.kill(int(open(pid_file).read().strip()), signal.SIGTERM)',
      '            except Exception: pass',
      '            try: os.remove(pid_file)',
      '            except Exception: pass',
      '    root = os.path.expanduser("' + rootPath + '")',
      '    try:',
      '        if os.path.isdir(root): shutil.rmtree(root); removed.append(root)',
      '    except Exception: pass',
      '    for f in [_tmp_path("/tmp/etb_build_' + safeId + '.json"), os.path.expanduser("' + registryFile + '")]:',
      '        try:',
      '            if os.path.exists(f): os.remove(f); removed.append(f)',
      '        except Exception: pass',
      '    reg_dir = os.path.expanduser("~/extella-plugins/_registry")',
      '    if os.path.isdir(reg_dir):',
      '        for rf in glob.glob(os.path.join(reg_dir, "*.json")):',
      '            try:',
      '                with open(rf, "r", encoding="utf-8") as _fh: _m = json.load(_fh)',
      '                if isinstance(_m, dict) and _m.get("id") == ' + JSON.stringify(pluginId) + ':',
      '                    os.remove(rf); removed.append(rf)',
      '            except Exception: pass',
      // Тумбстоун удаления: зомби-хвост оборванного рана установки может
      // дописать манифест ПОСЛЕ этой чистки — по тумбстоуну джанитор
      // syncFromDevice его проигнорирует и удалит. Снимается при переустановке
      // (registry.clearDeviceTombstone).
      '    try:',
      '        import time',
      '        t_dir = os.path.join(reg_dir, "_removed")',
      '        os.makedirs(t_dir, exist_ok=True)',
      '        t_fp = os.path.join(t_dir, ' + JSON.stringify(safeId) + ' + ".json")',
      '        with open(t_fp, "w", encoding="utf-8") as _tf:',
      '            json.dump({"id": ' + JSON.stringify(pluginId) + ', "removed_at": time.time()}, _tf)',
      '        removed.append(t_fp)',
      '    except Exception: pass',
      '    return json.dumps({"status": "ok", "removed": removed})'
    ].join('\n');

    ETB.api.kvGet('_device_id')
      .then(function (res) { return (res && res.value) || null; })
      .catch(function () { return null; })
      .then(function (deviceId) {
        // КОРЕНЬ бага «удаляется и снова появляется»: KV _device_id пуст у всех,
        // а без target global-эксперт уходит на СЛУЧАЙНОЕ устройство контура
        // (например VPS) — там файла нет, ран «успешен», файл здесь жив.
        // Фолбэк на локальный ID устройства — как в syncFromDevice.
        if (!deviceId) {
          try {
            deviceId = (window.extellaDesktop && typeof window.extellaDesktop.getDeviceID === 'function')
              ? window.extellaDesktop.getDeviceID() : null;
          } catch (e) { deviceId = null; }
        }
        return ETB.api.saveExpert({
          name: fnName,
          description: 'Cleanup plugin ' + pluginId,
          code: code,
          kwargs: {},
          cspl: 'fython'
        }).then(function () {
          var opts = {};
          if (deviceId) opts.target = deviceId;
          // Чистка обязана закрепиться: один тихо упавший облачный ран оставлял
          // файл карточки живым, и синк воскрешал её («удаляется и снова
          // появляется»). Ретраим с паузой; removing-метка прячет карточку,
          // пока файл жив, поэтому повтор безопасен и идемпотентен.
          function runCleanup() {
            return ETB.api.runExpert(fnName, {}, opts).then(function (r) {
              if (r && r.status === 'error') throw new Error(r.message || 'cleanup error');
              return r;
            }).catch(function (e) {
              if (deviceId) return ETB.api.runExpert(fnName, {}, {}).then(function (r2) {
                if (r2 && r2.status === 'error') throw new Error(r2.message || 'cleanup error');
                return r2;
              });
              throw e;
            });
          }
          return runCleanup().catch(function () {
            return new Promise(function (resolve) { setTimeout(resolve, 8000); })
              .then(runCleanup);
          });
        }).then(function () {
          // Remove the throwaway cleanup expert itself.
          return ETB.api.deleteExpert(fnName).catch(function () {});
        });
      })
      .catch(function () {});

    // 4) Local registry: drop the custom entry and evict any cached panel.
    ETB.registry.removeCustom(pluginId);
    if (ETB.router && ETB.router.evict) ETB.router.evict(pluginId);
  }

  var MKT_STYLES = [
    '#_etbv2_mkt_ov{',
      'position:absolute;inset:0;z-index:2147483632;',
      'background:var(--etb-bg,#0a0a0a);',
      'display:flex;flex-direction:column;',
      'animation:_etbv2_slide_in .18s ease;',
    '}',
    '#_etbv2_root[data-etb-fallback] ~ #_etbv2_viewport #_etbv2_mkt_ov,',
    'body:not(:has(#_etbv2_viewport)) #_etbv2_mkt_ov{',
      'position:fixed;inset:0;',
    '}',
    '#_etbv2_mkt_frame{flex:1;border:none;display:block;width:100%;}',
    '#_etbv2_mkt_ov.win{position:fixed;inset:auto;left:6vw;top:5vh;width:72vw;height:86vh;',
      'border:1px solid rgba(140,140,140,.45);border-radius:6px;overflow:hidden;',
      'box-shadow:0 18px 60px rgba(0,0,0,.45);}',
    '#_etbv2_mkt_grip{display:none;height:20px;flex-shrink:0;cursor:move;',
      'background:var(--etb-s1,#141414);border-bottom:1px solid rgba(140,140,140,.25);}',
    '#_etbv2_mkt_grip::after{content:"";display:block;width:44px;height:4px;border-radius:2px;',
      'background:rgba(140,140,140,.5);margin:8px auto 0;}',
    '#_etbv2_mkt_ov.win #_etbv2_mkt_grip{display:block;}',
    '#_etbv2_mkt_ov.dragging #_etbv2_mkt_frame{pointer-events:none;}',
    '#_etbv2_mkt_rs{display:none;position:absolute;right:0;bottom:0;width:20px;height:20px;',
      'cursor:nwse-resize;z-index:5;}',
    '#_etbv2_mkt_rs::after{content:"";position:absolute;right:4px;bottom:4px;width:8px;height:8px;',
      'border-right:2px solid rgba(140,140,140,.7);border-bottom:2px solid rgba(140,140,140,.7);}',
    '#_etbv2_mkt_ov.win #_etbv2_mkt_rs{display:block;}',
    '#_etbv2_mkt_chip{position:fixed;right:16px;bottom:64px;z-index:2147483639;',
      'background:var(--etb-s1,#141414);color:var(--etb-tx,#eee);border:1px solid rgba(140,140,140,.45);',
      'border-radius:999px;padding:9px 16px;font:600 12.5px system-ui;cursor:pointer;',
      'box-shadow:0 10px 30px rgba(0,0,0,.35);}'
  ].join('');

  function _ensureStyles() {
    if (document.getElementById('_etbv2_mkt_styles')) return;
    var s = document.createElement('style');
    s.id = '_etbv2_mkt_styles';
    s.textContent = MKT_STYLES;
    document.head.appendChild(s);
  }

  return {
    open: function () {
      var existing = document.getElementById('_etbv2_mkt_ov');
      if (existing) {
        // A truly-open overlay → nothing to do. A stale one still finishing its
        // close animation → drop it now so we can open a fresh instance.
        if (existing.getAttribute('data-closing') !== '1') return;
        if (existing.parentNode) existing.parentNode.removeChild(existing);
      }
      _ensureStyles();

      var ov = document.createElement('div');
      ov.id = '_etbv2_mkt_ov';

      var iframe = document.createElement('iframe');
      iframe.id = '_etbv2_mkt_frame';
      // Use blob: URL — no local HTTP server required
      var blob = new Blob([_ETB_MARKETPLACE_HTML], { type: 'text/html' });
      _blobUrl = URL.createObjectURL(blob);
      iframe.src = _blobUrl;
      iframe.setAttribute('allow', 'clipboard-read;clipboard-write');
      iframe.addEventListener('load', function () {
        if (iframe.contentWindow && ETB.theme) {
          try {
            iframe.contentWindow.postMessage(
              { type: 'etb_theme', theme: ETB.theme.current() }, '*'
            );
          } catch (e) {}
        }
        _sendSession();
      }, { once: true });

      // Сессия текущего пользователя (токен + его агент) — витрине, чтобы окна
      // плагинов могли ходить в API от имени вошедшего пользователя. Без этого
      // чат-карточки молчат («Could not connect»). Шлём на load, при появлении
      // токена и после определения агента; при смене аккаунта — заново.
      function _sendSession() {
        if (!iframe.contentWindow) return;
        var send = function () {
          try {
            iframe.contentWindow.postMessage({
              type: 'etb_session',
              token: (ETB.auth && ETB.auth.getToken()) || '',
              agentId: (ETB.api && ETB.api.currentAgent) ? ETB.api.currentAgent() : ''
            }, '*');
          } catch (e) {}
        };
        send();
        if (ETB.api && ETB.api.resolveAgent) ETB.api.resolveAgent().then(send).catch(function () {});
      }
      if (ETB.auth) {
        ETB.auth.onToken(function () { _sendSession(); });
        ETB.auth.onSessionChange(function () { _sendSession(); });
      }
      // Самовосстановление: окно плагина сообщило, что у агента битый ключ →
      // переключаемся на следующего кандидата и раздаём сессию заново.
      window.addEventListener('message', function (e) {
        if (!e.data || e.data.type !== 'etb_agent_bad') return;
        if (ETB.api && ETB.api.advanceAgent && ETB.api.advanceAgent()) _sendSession();
      });
      var grip = document.createElement('div');
      grip.id = '_etbv2_mkt_grip';
      grip.title = 'Перетащить окно';
      ov.appendChild(grip);
      ov.appendChild(iframe);
      (function () {
        var sx, sy, ox, oy, on = false;
        grip.addEventListener('mousedown', function (e) {
          on = true; sx = e.clientX; sy = e.clientY;
          var r = ov.getBoundingClientRect(); ox = r.left; oy = r.top;
          ov.classList.add('dragging'); e.preventDefault();
        });
        document.addEventListener('mousemove', function (e) {
          if (!on) return;
          var nx = Math.max(0, Math.min(ox + e.clientX - sx, window.innerWidth - 120));
          var ny = Math.max(0, Math.min(oy + e.clientY - sy, window.innerHeight - 60));
          ov.style.left = nx + 'px'; ov.style.top = ny + 'px';
        });
        document.addEventListener('mouseup', function () {
          if (on) { on = false; ov.classList.remove('dragging'); }
        });
      })();
      var rs = document.createElement('div');
      rs.id = '_etbv2_mkt_rs';
      rs.title = 'Потянуть, чтобы изменить размер';
      ov.appendChild(rs);
      (function () {
        var sx, sy, ow, oh, on = false;
        rs.addEventListener('mousedown', function (e) {
          on = true; sx = e.clientX; sy = e.clientY;
          var r = ov.getBoundingClientRect(); ow = r.width; oh = r.height;
          if (!ov.style.left) { ov.style.left = r.left + 'px'; ov.style.top = r.top + 'px'; }
          ov.classList.add('dragging'); e.preventDefault(); e.stopPropagation();
        });
        document.addEventListener('mousemove', function (e) {
          if (!on) return;
          ov.style.width = Math.max(560, Math.min(ow + e.clientX - sx, window.innerWidth)) + 'px';
          ov.style.height = Math.max(380, Math.min(oh + e.clientY - sy, window.innerHeight)) + 'px';
        });
        document.addEventListener('mouseup', function () {
          if (on) { on = false; ov.classList.remove('dragging'); }
        });
      })();

      if (!window.__etbMktThemeHook && ETB.theme && ETB.theme.onChange) {
        window.__etbMktThemeHook = true;
        ETB.theme.onChange(function (theme) {
          var frame = document.getElementById('_etbv2_mkt_frame');
          if (frame && frame.contentWindow) {
            try {
              frame.contentWindow.postMessage({ type: 'etb_theme', theme: theme }, '*');
            } catch (e) {}
          }
        });
      }

      var mount = (ETB.shell && ETB.shell.getViewport)
        ? ETB.shell.getViewport()
        : (document.getElementById('_etbv2_root') || document.body);
      mount.appendChild(ov);

      // Agents can drop new manifests into the device registry while Extella
      // is running (e.g. a chat session installs a plugin). Boot-time sync
      // alone misses those — refresh on every marketplace open, best-effort,
      // and tell the iframe to re-render if anything new arrived.
      try {
        ETB.api.kvGet('_device_id').then(function (r) {
          if (r && r.value) return r.value;
          try {
            return (window.extellaDesktop && typeof window.extellaDesktop.getDeviceID === 'function')
              ? window.extellaDesktop.getDeviceID() : null;
          } catch (e) { return null; }
        }).then(function (did) {
          if (!did) return;
          return ETB.registry.syncFromDevice(did).then(function (added) {
            if (added && added.length) {
              var frame = document.getElementById('_etbv2_mkt_frame');
              if (frame && frame.contentWindow) {
                try { frame.contentWindow.postMessage({ type: 'etb_reload_plugins' }, '*'); } catch (e) {}
              }
              if (ETB.tabs && ETB.tabs.refresh) ETB.tabs.refresh();
            }
          });
        }).catch(function () {});
      } catch (e) {}

      // Merch layer: the hero story (and future collections/promos) comes
      // from KV '_mkt_merch', so the storefront is re-merchandised from the
      // cloud without an app release. Sent to the iframe once both the
      // payload and the document are ready.
      var _merchPayload = null;
      function _sendMerch() {
        if (!_merchPayload) return;
        var frame = document.getElementById('_etbv2_mkt_frame');
        if (frame && frame.contentWindow) {
          try { frame.contentWindow.postMessage({ type: 'etb_merch', data: _merchPayload }, '*'); } catch (e) {}
        }
      }
      // Fetch cloud merch only once the session token is ready. getToken() is
      // empty until the async auth flow resolves, so a one-shot kvGet fired at
      // open() would send an empty X-Auth-Token → 401 → silently no hero (a
      // race: the hero showed only when the token happened to be ready in time).
      // onToken() fires now if the token is present, else when it arrives; then
      // retry a few times to ride out a slow first response. Delivery to the
      // iframe is belt-and-suspenders: this push + the iframe's etb_ready pull.
      function _fetchMerch(tries) {
        tries = tries || 0;
        ETB.api.kvGet('_mkt_merch').then(function (r) {
          var ok = r && r.value != null && r.value !== '' &&
                   r.status !== 'error' && r.status !== 'not_found';
          if (ok) {
            try { _merchPayload = (typeof r.value === 'string') ? JSON.parse(r.value) : r.value; }
            catch (e) { return; }
            _sendMerch();
            return;
          }
          if (tries < 4) setTimeout(function () { _fetchMerch(tries + 1); }, 1200);
        }).catch(function () {
          if (tries < 4) setTimeout(function () { _fetchMerch(tries + 1); }, 1200);
        });
      }
      try {
        if (ETB.auth && ETB.auth.onToken) ETB.auth.onToken(function () { _fetchMerch(0); });
        else _fetchMerch(0);
      } catch (e) { _fetchMerch(0); }
      iframe.addEventListener('load', _sendMerch);

      // Do NOT call ETB.nav.syncUI() here — nav.set() already called _paintTabs()
      // before invoking open(). Calling syncUI() now inspects the DOM and can see
      // a library overlay that is still animating closed (150ms), causing it to
      // override _active back to 'library' and mis-highlight the wrong tab.

      // Listen for install/open/close events from marketplace iframe.
      // Store reference so it can be removed on close.
      _msgHandler = function (e) {
        if (!e.data) return;
        // Iframe finished booting and attached its message listener → (re)push
        // the merch payload. Guarantees delivery regardless of who was ready
        // first (payload vs document).
        if (e.data.type === 'etb_ready') { _sendMerch(); return; }

        // ── Storefront service bridges (KV / rules / agents) ────────────────
        // Let the store manage Skills in-place (as a category) rather than in a
        // The storefront iframe (blob: origin) can't resolve the session token
        // itself (no cookies, no DOM user-id). It asks the parent for the live
        // token so direct api.js calls (e.g. GitHub install) don't 401. Same-app
        // trust boundary; the token is the user's own and never logged.
        if (e.data.type === 'etb_request_token') {
          try {
            var _tf = document.getElementById('_etbv2_mkt_frame');
            var _tok = (window.ETB && ETB.auth && ETB.auth.getToken) ? ETB.auth.getToken() : '';
            if (_tf && _tf.contentWindow && _tok) {
              _tf.contentWindow.postMessage({ type: 'extella-token', token: _tok }, '*');
            }
          } catch (_) {}
          return;
        }

        // Dedicated, fail-closed Codex installer bridge. Unlike the generic
        // Expert bridge below, the iframe cannot choose the Expert, code,
        // repository, ref, credential, command, or target device. The trusted
        // host module pins all of those and binds execution to this Extella
        // Desktop instance.
        if (e.data.type === 'etb_codex_install') {
          var _cf = document.getElementById('_etbv2_mkt_frame');
          var _crid = String(e.data.reqId || '');
          var _cback = function (msg) {
            if (_cf && _cf.contentWindow) {
              try { _cf.contentWindow.postMessage(msg, '*'); } catch (_) {}
            }
          };
          if (!_cf || e.source !== _cf.contentWindow || !_crid) return;
          if (!ETB.codexInstaller || typeof ETB.codexInstaller.install !== 'function') {
            _cback({
              type: 'etb_codex_install_result',
              reqId: _crid,
              ok: false,
              code: 'installer_unavailable',
              error: 'Установщик Codex недоступен в этой версии Extella.'
            });
            return;
          }
          ETB.codexInstaller.install({
            onProgress: function (state) {
              _cback({
                type: 'etb_codex_install_progress',
                reqId: _crid,
                stage: state.stage,
                metadata: state.metadata || ETB.codexInstaller.metadata()
              });
            }
          }).then(function (result) {
            _cback({
              type: 'etb_codex_install_result',
              reqId: _crid,
              ok: true,
              result: result
            });
          }).catch(function (error) {
            _cback({
              type: 'etb_codex_install_result',
              reqId: _crid,
              ok: false,
              code: (error && error.code) || 'installer_failed',
              error: (error && error.message) || 'Не удалось подключить Codex.',
              stage: (error && error.installStage) || '',
              taskId: (error && error.taskId) || ''
            });
          });
          return;
        }

        // Отдельный fail-closed канал для Claude, зеркало Codex-канала.
        // Iframe не выбирает ни Expert, ни команду, ни репозиторий, ни ref, ни
        // креденшелы, ни устройство: всё закреплено в этом доверенном модуле.
        if (e.data.type === 'etb_claude_install') {
          var _lf = document.getElementById('_etbv2_mkt_frame');
          var _lrid = String(e.data.reqId || '');
          var _lback = function (msg) {
            if (_lf && _lf.contentWindow) {
              try { _lf.contentWindow.postMessage(msg, '*'); } catch (_) {}
            }
          };
          if (!_lf || e.source !== _lf.contentWindow || !_lrid) return;
          if (!ETB.claudeInstaller || typeof ETB.claudeInstaller.install !== 'function') {
            _lback({
              type: 'etb_claude_install_result',
              reqId: _lrid,
              ok: false,
              code: 'installer_unavailable',
              error: 'Установщик Claude недоступен в этой версии Extella.'
            });
            return;
          }
          ETB.claudeInstaller.install({
            onProgress: function (state) {
              _lback({
                type: 'etb_claude_install_progress',
                reqId: _lrid,
                stage: state.stage,
                metadata: state.metadata || ETB.claudeInstaller.metadata()
              });
            }
          }).then(function (result) {
            _lback({ type: 'etb_claude_install_result', reqId: _lrid, ok: true, result: result });
          }).catch(function (error) {
            _lback({
              type: 'etb_claude_install_result',
              reqId: _lrid,
              ok: false,
              code: (error && error.code) || 'installer_failed',
              error: (error && error.message) || 'Не удалось подключить Claude.',
              stage: (error && error.installStage) || ''
            });
          });
          return;
        }

        if (e.data.type === 'etb_claude_status') {
          var _lsf = document.getElementById('_etbv2_mkt_frame');
          var _lsrid = String(e.data.reqId || '');
          if (!_lsf || e.source !== _lsf.contentWindow || !_lsrid) return;
          var _lsback = function (msg) {
            if (_lsf && _lsf.contentWindow) {
              try { _lsf.contentWindow.postMessage(msg, '*'); } catch (_) {}
            }
          };
          if (!ETB.claudeInstaller ||
              typeof ETB.claudeInstaller.connectionStatus !== 'function') {
            _lsback({
              type: 'etb_claude_status_result',
              reqId: _lsrid,
              ok: false,
              error: 'Статус подключения Claude недоступен.'
            });
            return;
          }
          ETB.claudeInstaller.connectionStatus().then(function (status) {
            _lsback({ type: 'etb_claude_status_result', reqId: _lsrid, ok: true, status: status });
          }).catch(function (error) {
            _lsback({
              type: 'etb_claude_status_result',
              reqId: _lsrid,
              ok: false,
              error: (error && error.message) ||
                'Не удалось проверить статус подключения Claude.'
            });
          });
          return;
        }

        if (e.data.type === 'etb_codex_status') {
          var _csf = document.getElementById('_etbv2_mkt_frame');
          var _csrid = String(e.data.reqId || '');
          if (!_csf || e.source !== _csf.contentWindow || !_csrid) return;
          var _csback = function (msg) {
            if (_csf && _csf.contentWindow) {
              try { _csf.contentWindow.postMessage(msg, '*'); } catch (_) {}
            }
          };
          if (!ETB.codexInstaller ||
              typeof ETB.codexInstaller.connectionStatus !== 'function') {
            _csback({
              type: 'etb_codex_status_result',
              reqId: _csrid,
              ok: false,
              error: 'Статус подключения Codex недоступен.'
            });
            return;
          }
          ETB.codexInstaller.connectionStatus().then(function (status) {
            _csback({
              type: 'etb_codex_status_result',
              reqId: _csrid,
              ok: true,
              status: status
            });
          }).catch(function (error) {
            _csback({
              type: 'etb_codex_status_result',
              reqId: _csrid,
              ok: false,
              error: (error && error.message) ||
                'Не удалось проверить статус подключения Codex.'
            });
          });
          return;
        }

        // separate plugin window. Mirrors the router bridges; KV is scoped to
        // '_mkt_' keys so a page can never touch secrets.
        if (e.data.type === 'etb_kv_get' || e.data.type === 'etb_kv_set' ||
            e.data.type === 'etb_rule_add' || e.data.type === 'etb_rule_remove' ||
            e.data.type === 'etb_agents_list' ||
            e.data.type === 'etb_run_expert' || e.data.type === 'etb_run_agent') {
          var _mf = document.getElementById('_etbv2_mkt_frame');
          var _rid = e.data.reqId, _t = e.data.type;
          var _back = function (msg) { if (_mf && _mf.contentWindow) { try { _mf.contentWindow.postMessage(msg, '*'); } catch (_) {} } };
          var _kerr = function (m) { _back({ type: 'etb_kv_result', reqId: _rid, ok: false, error: m }); };
          try {
            if (_t === 'etb_kv_get' || _t === 'etb_kv_set') {
              var _key = String(e.data.key || '');
              // Витринные каталоги (_mkt_*) — глобальные, один канал на всех.
              // agent_state:<id> — ЛИЧНЫЙ слой поверх каталога (убран со стола,
              // имя, пауза, расписание): пишется в скоуп пользователя. Раньше
              // этот префикс отбрасывался «key not allowed», из-за чего удаление
              // карточки/ярлыка агента молча не сохранялось и он возвращался.
              var _isMkt = _key.indexOf('_mkt_') === 0;
              var _isAgSt = _key.indexOf('agent_state:') === 0;
              // agent_runs:<id> — история запусков в кабинете агента; cap_<id>_manifest —
              // операции динамических CLI-инструментов. Оба префикса витрина читает/пишет
              // штатно, но гейт их отбрасывал → «Запусков пока нет» и «Операции не
              // найдены» были враньём по конструкции у ВСЕХ пользователей.
              var _isAgRuns = _key.indexOf('agent_runs:') === 0;
              var _isCapMan = /^cap_[A-Za-z0-9_-]+_manifest$/.test(_key);
              var _isReservedMcpRegistry =
                _key === '_mkt_xtl_evolution_mcp_registry_v1';
              if (_isReservedMcpRegistry) {
                _kerr('key reserved for the trusted Evolution MCP provider');
                return;
              }
              if (!_isMkt && !_isAgSt && !_isAgRuns && !_isCapMan) { _kerr('key not allowed'); return; }
              var _scope = (_isMkt || _isCapMan) ? { global: true } : {};
              if (_t === 'etb_kv_get') {
                ETB.api.kvGet(_key, _scope)
                  .then(function (r) { _back({ type: 'etb_kv_result', reqId: _rid, ok: true, value: (r && r.value != null) ? r.value : null }); })
                  .catch(function (er) { _kerr((er && er.message) || 'kv get failed'); });
              } else {
                ETB.api.kvSet(_key, e.data.value, e.data.description || 'Marketplace (storefront)', _scope)
                  .then(function () { _back({ type: 'etb_kv_result', reqId: _rid, ok: true }); })
                  .catch(function (er) { _kerr((er && er.message) || 'kv set failed'); });
              }
            } else if (_t === 'etb_rule_add') {
              ETB.api.rulesAdd(String(e.data.rule || ''), e.data.agents)
                .then(function (refs) { _back({ type: 'etb_rule_result', reqId: _rid, ok: !!(refs && refs.length), refs: refs || [] }); })
                .catch(function (er) { _back({ type: 'etb_rule_result', reqId: _rid, ok: false, error: (er && er.message) || 'rule add failed' }); });
            } else if (_t === 'etb_rule_remove') {
              ETB.api.rulesRemove(e.data.refs || e.data.ruleId)
                .then(function () { _back({ type: 'etb_rule_result', reqId: _rid, ok: true }); })
                .catch(function (er) { _back({ type: 'etb_rule_result', reqId: _rid, ok: false, error: (er && er.message) || 'rule remove failed' }); });
            } else if (_t === 'etb_agents_list') {
              ETB.api.agentsList()
                .then(function (r) { var list = (r && r.agents) || []; _back({ type: 'etb_agents_result', reqId: _rid, ok: true, agents: list.map(function (a) { return { id: a.id, name: a.name, model: a.model }; }) }); })
                .catch(function (er) { _back({ type: 'etb_agents_result', reqId: _rid, ok: false, error: (er && er.message) || 'agents failed' }); });
            } else if (_t === 'etb_run_expert') {
              // Expert bridge for the storefront (install a CLI capability, etc.).
              // Runs in toolbar context (has API access); idempotent resolvers make
              // a double-run harmless if router's per-plugin handler also fires.
              // runExpertAsync: если сервер откладывает длинный прогон (kp_ingest, синтез,
              // большие пачки) в задачу — поллит её до готовности (иначе прилетает
              // «deferred, use task_id as reference» вместо результата).
              var _expertName = String(e.data.name || '');
              var _expertParams = e.data.params || {};
              var _expertTargetsReservedMcpRegistry =
                (_expertName === '_etb_kv_get' ||
                 _expertName === '_etb_kv_set') &&
                String(_expertParams.key || '') ===
                  '_mkt_xtl_evolution_mcp_registry_v1';
              if (_expertTargetsReservedMcpRegistry) {
                _back({
                  type: 'etb_expert_result',
                  reqId: _rid,
                  ok: false,
                  error: 'key reserved for the trusted Evolution MCP provider'
                });
                return;
              }
              ETB.api.runExpertAsync(_expertName, _expertParams, { global: true, maxWait: 900000, interval: 2500 })
                .then(function (res) { _back({ type: 'etb_expert_result', reqId: _rid, ok: true, res: res }); })
                .catch(function (er) { _back({ type: 'etb_expert_result', reqId: _rid, ok: false, error: (er && er.message) || 'expert failed' }); });
            } else if (_t === 'etb_run_agent') {
              // «Найти и добавить»: агент работает минуты. Ack уходит сразу, а по
              // завершении шлём etb_agent_done с текстом ответа — витрина покажет
              // человеку итог (или причину отказа) вместо тишины.
              try {
                ETB.api.runAgentAsync(String(e.data.message || ''), { agent_id: e.data.agent_id, run_timeout: 600 })
                  .then(function (r) {
                    var txt = ''; try { txt = ETB.api.extractAgentText(r) || ''; } catch (_ex) {}
                    _back({ type: 'etb_agent_done', reqId: _rid, ok: true, answer: String(txt).slice(0, 600) });
                  })
                  .catch(function (er) {
                    _back({ type: 'etb_agent_done', reqId: _rid, ok: false, error: (er && er.message) || 'агент не ответил' });
                  });
              } catch (_ea) {}
              _back({ type: 'etb_agent_result', reqId: _rid, ok: true, started: true });
            }
          } catch (er) {
            var rt = _t === 'etb_run_agent' ? 'etb_agent_result'
                   : (_t === 'etb_run_expert' ? 'etb_expert_result'
                   : (_t.indexOf('rule') >= 0 ? 'etb_rule_result'
                   : (_t.indexOf('agents') >= 0 ? 'etb_agents_result' : 'etb_kv_result')));
            _back({ type: rt, reqId: _rid, ok: false, error: (er && er.message) || 'bridge failed' });
          }
          return;
        }
        if (e.data.type !== 'etb_plugin_action') return;
        var action = e.data.action;
        var pluginId = e.data.pluginId;
        if (action === 'install' && pluginId) {
          ETB.registry.install(pluginId);
          ETB.tabs.refresh();
        } else if (action === 'install_featured' && pluginId) {
          // One-click install of a curated plugin: provision its pre-authored
          // experts/concepts on the user's account, then report back so the
          // iframe can flip the button state without a reload.
          var plugin = ETB.registry.getById(pluginId);
          var _reply = function (ok, message) {
            var frame = document.getElementById('_etbv2_mkt_frame');
            if (frame && frame.contentWindow) {
              frame.contentWindow.postMessage({
                type: 'etb_install_result',
                pluginId: pluginId,
                ok: ok,
                message: message || ''
              }, '*');
            }
          };
          if (!plugin) { _reply(false, 'Unknown plugin: ' + pluginId); return; }
          ETB.plugins.provision(plugin, 'install').then(function () {
            ETB.tabs.refresh();
            _reply(true);
          }).catch(function (err) {
            _reply(false, (err && err.message) || 'provisioning failed');
          });
        } else if (action === 'uninstall' && pluginId) {
          // Prefer the manifest snapshot passed by the iframe (captured before localStorage
          // was cleared) so CSPL cleanup has the correct artifact paths and pid files.
          var unPlugin = e.data.pluginData || ETB.registry.getById(pluginId);
          var hasArtifacts = !!(unPlugin && unPlugin.artifacts);
          // Любая запись из custom-реестра синхронизирована с устройства (syncFromDevice),
          // поэтому её надо чистить ПОЛНОСТЬЮ — иначе файл реестра на устройстве остаётся
          // и модель/плагин возвращается на следующем syncFromDevice (баг «Remove не держится»).
          var isCustom = !!(ETB.registry.getCustom && ETB.registry.getCustom().some(function (p) { return p && p.id === pluginId; }));
          // pluginData приходит ТОЛЬКО для карточек из custom-реестра витрины —
          // это самодостаточный признак «чистить устройство». Хост-кэш сразу
          // после рестарта мог ещё не досинкаться (гонка) — isCustom тогда
          // ложно false, чистка не запускалась, файл жил и карточка возвращалась.
          var hasSnapshot = !!e.data.pluginData;
          if (/^(?:gh_|hf_)/.test(pluginId) || hasArtifacts || isCustom || hasSnapshot) {
            // Agent-installed / GitHub / HuggingFace / device-synced plugin: full cleanup of every
            // artifact + on-device registry file + custom entry + evict cached panel.
            if (ETB.registry.markRemoving) ETB.registry.markRemoving(pluginId);
            _removeAgentPlugin(pluginId, unPlugin);
          } else {
            // Built-in / curated plugin: remove only Experts explicitly owned
            // by that manifest, then mark the UI uninstalled. Never infer
            // ownership from an arbitrary name.
            var ownedNames = [];
            if (unPlugin && unPlugin.owned_experts === true) {
              var declared = unPlugin.experts || [];
              (unPlugin.expert_defs || []).forEach(function (def) {
                var name = String(def && def.name || '');
                if (name && declared.indexOf(name) !== -1) {
                  ownedNames.push(name);
                }
              });
            }
            if (ownedNames.length) {
              var _replyUninstall = function (ok, message) {
                var frame = document.getElementById('_etbv2_mkt_frame');
                if (frame && frame.contentWindow) {
                  frame.contentWindow.postMessage({
                    type: 'etb_uninstall_result',
                    pluginId: pluginId,
                    ok: ok,
                    message: message || ''
                  }, '*');
                }
              };
              function _expertAbsent(result) {
                var status = String(result && result.status || '').toLowerCase();
                var message = String(result && result.message || '');
                return status === 'not_found' ||
                  (status === 'error' && /(not found|does not exist|не найден)/i.test(message));
              }
              Promise.all(ownedNames.map(function (name) {
                return ETB.api.deleteExpert(name).then(function (result) {
                  if (!result || (result.status !== 'success' && !_expertAbsent(result))) {
                    throw new Error(name + ': Expert delete was not confirmed');
                  }
                  return ETB.api.getExpert(name, { global: true }).then(function (check) {
                    if (!_expertAbsent(check)) {
                      throw new Error(name + ': Expert still exists after delete');
                    }
                  });
                });
              })).then(function () {
                ETB.registry.uninstall(pluginId);
                if (ETB.router && ETB.router.evict) ETB.router.evict(pluginId);
                ETB.tabs.refresh();
                _replyUninstall(true);
              }).catch(function (error) {
                // The storefront optimistically removed the local flag. Restore
                // it when owned-resource cleanup was not proven.
                ETB.registry.install(pluginId);
                ETB.tabs.refresh();
                _replyUninstall(false, (error && error.message) || 'Expert cleanup failed');
              });
              return;
            }
            ETB.registry.uninstall(pluginId);
            if (ETB.router && ETB.router.evict) ETB.router.evict(pluginId);
          }
          ETB.tabs.refresh();
        } else if (action === 'open' && pluginId) {
          ETB.marketplace.close();
          ETB.nav.syncUI();
          // returnTo: закрыв плагин, пользователь возвращается в Plugins, откуда пришёл.
          ETB.router.openById(pluginId, { returnTo: 'plugins' });
          ETB.nav.syncUI();
        } else if (action === 'close') {
          ETB.nav.set('chat');
        } else if (action === 'mkt_win') {
          var _ov = document.getElementById('_etbv2_mkt_ov');
          if (_ov) { _ov.classList.toggle('win'); if (!_ov.classList.contains('win')) { _ov.style.left = ''; _ov.style.top = ''; _ov.style.width = ''; _ov.style.height = ''; } }
        } else if (action === 'mkt_min') {
          var _ov2 = document.getElementById('_etbv2_mkt_ov');
          if (_ov2) {
            _ov2.style.display = 'none';
            if (!document.getElementById('_etbv2_mkt_chip')) {
              var chip = document.createElement('div');
              chip.id = '_etbv2_mkt_chip';
              chip.textContent = 'Extella Plugins';
              chip.onclick = function () { _ov2.style.display = ''; chip.remove(); };
              document.body.appendChild(chip);
            }
          }
        }
      };
      window.addEventListener('message', _msgHandler);
    },

    close: function (opts) {
      if (_msgHandler) {
        window.removeEventListener('message', _msgHandler);
        _msgHandler = null;
      }
      if (_blobUrl) { URL.revokeObjectURL(_blobUrl); _blobUrl = null; }
      var ov = document.getElementById('_etbv2_mkt_ov');
      if (ov) {
        // Mark as closing synchronously so nav.syncUI() stops counting it as the
        // active Plugins surface during the 150ms exit animation.
        ov.setAttribute('data-closing', '1');
        ov.style.animation = '_etbv2_slide_out .15s ease forwards';
        setTimeout(function () {
          if (ov.parentNode) ov.parentNode.removeChild(ov);
        }, 150);
      }
      if (!opts || !opts.silent) ETB.nav.syncUI();
    }
  };
})();
