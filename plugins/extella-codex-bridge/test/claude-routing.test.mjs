import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  TargetResolutionError,
  candidateDevices,
  isBridgeConfigured,
  resolveBridgeTarget,
  unwrap,
} from "../../extella-claude-bridge/scripts/target-resolver.mjs";

const CLAUDE_PLUGIN = resolve(import.meta.dirname, "..", "..", "extella-claude-bridge");
const INSTALLER = join(CLAUDE_PLUGIN, "integrations", "extella-desktop", "claude-installer.js");
const MAC = "55555555-5555-4555-8555-555555555555";
const CLOUD = "66666666-6666-4666-8666-666666666666";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Measured replies to a probe with an empty prompt. The bridge is its own
// indicator: the empty prompt is rejected AFTER the bridge check, so the two
// machines answer differently without a model and without a second Expert.
function probePayload({ configured }) {
  // Both envelopes, as the gateway and the core deliver them.
  return {
    result: {
      result: JSON.stringify(
        configured
          ? { status: "error", code: "invalid_prompt",
              message: "prompt must contain 1..4000 characters" }
          : { status: "error", code: "bridge_not_configured",
              message: "Local Claude bridge is not configured" },
      ),
    },
  };
}

function platform({ targets, healthyDevice = null, failOn = [] }) {
  const asked = [];
  return {
    asked,
    searchTargets: async () => ({ targets }),
    probeBridge: async (device) => {
      asked.push(device);
      if (failOn.includes(device)) throw new Error("device unreachable");
      return probePayload({ configured: device === healthyDevice });
    },
  };
}

// ── The device is chosen at call time, never stored ────────────────────────

test("no device identifier is written into the rule, the Expert, or the page", async () => {
  const sources = await Promise.all([
    readFile(INSTALLER, "utf8"),
    readFile(join(CLAUDE_PLUGIN, "experts", "extella_claude_product_setup.py"), "utf8"),
    readFile(join(CLAUDE_PLUGIN, "experts", "extella_claude_account_bridge_v1.fython"), "utf8"),
    readFile(join(CLAUDE_PLUGIN, "scripts", "target-resolver.mjs"), "utf8"),
  ]);
  // Devices are re-registered — this account already shows "перерегистрация
  // 30.07, прежний 11b0c773 мёртв". A pinned identifier would outlive its
  // device and route calls nowhere, silently.
  for (const source of sources) {
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(#|\/\/)/.test(line))
      .join("\n");
    assert.equal(UUID.test(code), false, "a device UUID must not be stored");
  }
});

test("the rule separates the chat path from the external one", async () => {
  const source = await readFile(INSTALLER, "utf8");
  const declarations = source.slice(
    source.indexOf("var ROUTING_RULE_MARKER"),
    source.indexOf("var _running"),
  );
  const rule = Function(`${declarations}\nreturn ROUTING_RULE_TEXT;`)();

  // Measured from a chat: run_expert(global=true) without targets reaches the
  // user's machine and Claude answered. The earlier blanket ban on targetless
  // calls came from measuring only the external MCP, whose default target is a
  // cloud container, and it forbade the one path that works.
  assert.ok(rule.includes("targets НЕ указывай"));
  assert.equal(rule.includes("НИКОГДА не вызывай run_expert без targets"), false);

  // Resolution stays, but only where it belongs: after bridge_not_configured.
  const fallback = rule.slice(rule.indexOf("bridge_not_configured"));
  assert.ok(fallback.includes("search_targets"));
  assert.ok(fallback.includes("targets=[device_id]"));
  assert.ok(fallback.includes("пустым prompt"));
  // An empty target search means "you are in a chat", not "no devices exist".
  assert.ok(rule.includes("это не «целей нет»"));

  // Expert not found is named as unrecoverable rather than retried.
  assert.ok(rule.includes("Expert not found"));
  assert.ok(rule.includes("Повторять бесполезно"));
  assert.equal(UUID.test(rule), false);
});
// ── Resolution ─────────────────────────────────────────────────────────────

test("only available candidates are considered, and duplicates collapse", () => {
  const devices = candidateDevices({
    targets: [
      { device_id: MAC, available: true },
      { device_id: MAC, available: true },
      { device_id: CLOUD, available: false },
      { device_id: "not-a-uuid", available: true },
      { available: true },
    ],
  });
  assert.deepEqual(devices, [MAC]);
  assert.deepEqual(candidateDevices({}), []);
  assert.deepEqual(candidateDevices(null), []);
});

test("a reachable device without the bridge is not the target", async () => {
  // "Устройство доступно" and "мост на нём поднят" are different claims. The
  // cloud container is available and answers — and has no bridge.
  const api = platform({
    targets: [
      { device_id: CLOUD, available: true },
      { device_id: MAC, available: true },
    ],
    healthyDevice: MAC,
  });
  assert.equal(await resolveBridgeTarget(api), MAC);
  assert.deepEqual(api.asked, [CLOUD, MAC], "candidates are probed in order");
});

test("an unreachable candidate does not stop the search", async () => {
  const api = platform({
    targets: [
      { device_id: CLOUD, available: true },
      { device_id: MAC, available: true },
    ],
    healthyDevice: MAC,
    failOn: [CLOUD],
  });
  assert.equal(await resolveBridgeTarget(api), MAC);
});

test("no candidates and no bridge are different failures", async () => {
  await assert.rejects(
    resolveBridgeTarget(platform({ targets: [{ device_id: CLOUD, available: false }] })),
    (error) => error instanceof TargetResolutionError && error.code === "no_available_target",
  );
  await assert.rejects(
    resolveBridgeTarget(platform({ targets: [{ device_id: CLOUD, available: true }] })),
    // Candidates existed but none carries the bridge: that tells the owner to
    // install, not to go looking for a device.
    (error) => error.code === "no_target_with_bridge" && error.checked === 1,
  );
  await assert.rejects(
    resolveBridgeTarget({
      searchTargets: async () => { throw new Error("offline"); },
      probeBridge: async () => ({}),
    }),
    (error) => error.code === "target_search_failed",
  );
});

test("the probe reads the payload, and only one code means no bridge", () => {
  assert.equal(isBridgeConfigured(probePayload({ configured: true })), true);
  assert.equal(isBridgeConfigured(probePayload({ configured: false })), false);
  // An earlier resolver probed the setup Expert, which is not global: every
  // target answered "Expert not found", so the probe distinguished nothing.
  assert.equal(isBridgeConfigured({ result: JSON.stringify({ status: "error" }) }), false);
  // H17: a Python repr must not be guessed at.
  assert.equal(isBridgeConfigured({ result: "{'code': 'invalid_prompt'}" }), false);
  assert.equal(unwrap({ result: { result: '{"a":1}' } }).a, 1);
  assert.equal(unwrap("not json"), null);
});

// ── The direct tool, and who must not be touched ───────────────────────────

test("no step claims to publish the Expert as a model tool", async () => {
  const source = await readFile(INSTALLER, "utf8");
  // Measured: a string written to agent.tools reads back, and the model still
  // does not see it — neither the Claude bridge nor the Codex one, though both
  // are in tools. The installer's readback proved the config save and was
  // presented as availability, which is the same false green as D2.
  assert.equal(source.includes("_attachBridgeTool"), false);
  assert.equal(source.includes("agentToolsUpdateScoped"), false);
  // Comment text wraps across lines, so match the prose with markers and line
  // breaks collapsed. Four assertions in this suite have now failed on
  // line-wrapped or commented text rather than on the thing they check.
  const prose = source.replace(/^\s*\/\/ ?/gm, "").replace(/\s+/g, " ");
  assert.ok(prose.includes("моделью не видна"), "the removal must state why");
  // The working path is run_expert through the system MCP, and the rule says so.
  const declarations = source.slice(
    source.indexOf("var ROUTING_RULE_MARKER"),
    source.indexOf("var _running"),
  );
  const rule = Function(`${declarations}\nreturn ROUTING_RULE_TEXT;`)();
  assert.ok(rule.includes("run_expert"));
  assert.equal(rule.includes("напрямую"), false, "no direct-tool promise remains");
});
test("the rule states the limits and the manual way around them", async () => {
  const source = await readFile(INSTALLER, "utf8");
  const declarations = source.slice(
    source.indexOf("var ROUTING_RULE_MARKER"),
    source.indexOf("var _running"),
  );
  const rule = Function(`${declarations}\nreturn ROUTING_RULE_TEXT;`)();

  // The agent reads the rule before answering and never reads the product page,
  // so a limit documented only on the page does not exist for it. Measured
  // symptom: on refusal it invented "Claude is unavailable" instead of naming
  // the real cause and the manual step.
  assert.ok(rule.includes("ОГРАНИЧЕНИЯ"));
  // A laptop that is asleep is not a transient error to retry.
  assert.ok(rule.includes("ждать бесполезно"));
  // The likeliest complaint: an agent created after the install has no bridge.
  assert.ok(rule.includes("Обновить раздачу"));
  assert.ok(rule.includes("не предлагай переустановку"));
  assert.ok(rule.includes("Публичным агентам"));
  // The plugin is optional; claiming otherwise sends people to an install that
  // needs a GitHub SSH key (D5).
  assert.ok(rule.includes("опционален"));
  assert.equal(UUID.test(rule), false);
});

test("the token is read from every canonical source, and agent_id from none of them", async () => {
  const source = await readFile(
    join(CLAUDE_PLUGIN, "experts", "extella_claude_product_setup.py"), "utf8");
  // Comments have fooled four assertions in this suite already — match code only.
  const code = source.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  // Measured 18.08.2026 on a tester's machine: environment, api_token.txt and
  // launchctl were all empty while the expert itself executed — the listener's
  // own config was the only token on the machine, and we did not read it.
  const order = [
    'os.environ.get("EXTELLA_API_TOKEN"',
    'api_token.txt',
    '"getenv", "EXTELLA_API_TOKEN"',
    'extella_wizard", "app", "config.json',
  ].map((needle) => code.indexOf(needle));
  for (const [i, at] of order.entries()) {
    assert.ok(at !== -1, `token source ${i} is missing`);
    if (i > 0) assert.ok(at > order[i - 1], `source ${i} out of canonical order`);
  }
  // DEPLOY_REQUIREMENTS п.4: the wizard config may name a different agent.
  const wizardBlock = code.slice(code.indexOf('extella_wizard'), code.indexOf('def token_sources_report'));
  assert.equal(wizardBlock.includes("agent_id"), false, "agent_id must not come from the wizard config");
  // The refusal reports source presence, never values.
  assert.ok(code.includes("token_sources_report"));
  const report = code.slice(code.indexOf("def token_sources_report"), code.indexOf("def validate_token"));
  assert.equal(/append\([^)]*value/.test(report), false, "the report must not carry token values");
});
