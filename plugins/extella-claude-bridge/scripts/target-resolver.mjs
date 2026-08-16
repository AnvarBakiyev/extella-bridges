// ── ДИНАМИЧЕСКОЕ РАЗРЕШЕНИЕ ЦЕЛИ ──────────────────────────────────────────
// Устройство выбирается в момент вызова и нигде не хранится.
//
// Почему не UUID в правиле, Expert-коде или странице: устройство
// перерегистрируется. В этом же аккаунте видно «перерегистрация 30.07, прежний
// 11b0c773 мёртв» — зашитый идентификатор пережил бы своё устройство и увёл бы
// вызов в никуда, причём молча.
//
// Почему вообще нужен резолвер: `run_expert` без `targets` уходит на цель по
// умолчанию, а она у внешнего MCP-подключения — облачный контейнер без
// launchctl. Мост оттуда честно отвечает `bridge_not_configured`. Это и есть
// дефект D3: строка «если прямого инструмента нет — вызови run_expert без
// targets» из правила Codex V4 описывает путь, который не работает.

const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Запрос описывает устройство словами, а не идентификатором. Совпадение по
// описанию — подсказка, а не доказательство: доказывает только проба.
const TARGET_QUERY = "рабочий листенер на машине пользователя, macOS";

class TargetResolutionError extends Error {
  constructor(code, checked = 0) {
    super("Claude bridge target could not be resolved");
    this.code = code;
    this.checked = checked;
  }
}

function isDeviceId(value) {
  return DEVICE_ID.test(value || "");
}

// Кандидаты: только доступные, с валидным device_id, без дублей. Порядок
// сохраняется — платформа возвращает их по убыванию похожести описания.
function candidateDevices(searchResult) {
  const rows = Array.isArray(searchResult?.targets) ? searchResult.targets : [];
  const seen = new Set();
  const devices = [];
  for (const row of rows) {
    const device = String(row?.device_id || "");
    if (row?.available !== true || !isDeviceId(device) || seen.has(device)) continue;
    seen.add(device);
    devices.push(device);
  }
  return devices;
}

// Проба безмодельная: `status` установочного Expert читает состояние и ничего
// не запускает. Целью считается только та машина, где мост уже отвечает, —
// «устройство доступно» и «мост на нём поднят» это разные утверждения.
function isBridgeHealthy(statusResult) {
  const payload = unwrap(statusResult);
  return (
    payload?.status === "success" &&
    payload?.bridge_healthy === true &&
    payload?.completed?.bridge === true
  );
}

// H17: шлюз и ядро заворачивают ответ независимо, а Python-словарь приезжает
// как repr. Разворачиваем обе обёртки и отказываемся угадывать не-JSON.
function unwrap(value) {
  let current = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current && typeof current === "object" && current.result !== undefined) {
      current = current.result;
      continue;
    }
    if (typeof current === "string") {
      try {
        current = JSON.parse(current);
      } catch {
        return null;
      }
      continue;
    }
    break;
  }
  return current && typeof current === "object" ? current : null;
}

/**
 * Разрешает цель заново на каждый вызов.
 *
 * @param {object} platform
 *   searchTargets({query, global, limit}) -> {targets: [...]}
 *   runStatus(deviceId) -> результат `status` установочного Expert на этой цели
 * @returns {Promise<string>} device_id, который не сохраняется вызывающим
 */
async function resolveBridgeTarget(platform, { limit = 10 } = {}) {
  let found;
  try {
    found = await platform.searchTargets({
      query: TARGET_QUERY,
      global: true,
      limit,
    });
  } catch {
    throw new TargetResolutionError("target_search_failed");
  }
  const candidates = candidateDevices(found);
  if (candidates.length === 0) {
    throw new TargetResolutionError("no_available_target");
  }
  let checked = 0;
  for (const device of candidates) {
    checked += 1;
    let status;
    try {
      status = await platform.runStatus(device);
    } catch {
      // Недоступная в этот момент цель — не повод останавливать перебор.
      continue;
    }
    if (isBridgeHealthy(status)) return device;
  }
  // Кандидаты были, но ни на одном мост не отвечает. Это другое состояние, чем
  // «целей нет», и владельцу оно говорит другое: ставить, а не искать.
  throw new TargetResolutionError("no_target_with_bridge", checked);
}

export {
  TARGET_QUERY,
  TargetResolutionError,
  candidateDevices,
  isBridgeHealthy,
  isDeviceId,
  resolveBridgeTarget,
  unwrap,
};
