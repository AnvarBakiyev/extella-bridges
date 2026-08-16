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

test("the rule forbids the fallback that Codex V4 prescribes", async () => {
  const source = await readFile(INSTALLER, "utf8");
  const declarations = source.slice(
    source.indexOf("var ROUTING_RULE_MARKER"),
    source.indexOf("var _running"),
  );
  const rule = Function(`${declarations}\nreturn ROUTING_RULE_TEXT;`)();

  // Measured: run_expert without targets lands in a cloud container with no
  // launchctl, and the bridge answers bridge_not_configured from there.
  assert.ok(rule.includes("НИКОГДА не вызывай run_expert без targets"));
  assert.ok(rule.includes("search_targets"));
  assert.ok(rule.includes("targets=[device_id]"));
  // The probe is part of the fallback: a reachable device is not a device
  // carrying the bridge.
  assert.ok(rule.includes("пустым prompt"));
  assert.ok(rule.includes("трёх шагов"));
  assert.ok(rule.includes("разрешай цель заново"));
  assert.ok(rule.includes("bridge_not_configured"));
  // The direct tool is the primary path, and the reason is stated.
  assert.ok(rule.indexOf("напрямую") < rule.indexOf("ЗАПАСНОЙ ПУТЬ"));
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

test("public agents keep the system MCP and are never rewritten", async () => {
  const source = await readFile(INSTALLER, "utf8");
  const body = source.slice(source.indexOf("function _attachBridgeTool"));
  // Public agents are shared platform objects: an account-local tool edit does
  // not stick, and reporting it as applied would be a false green.
  assert.ok(body.includes("isPublic"));
  assert.ok(body.includes("viaSystemMcp: true"));
  assert.ok(body.includes("_canRunGlobalExpert"));
  // A modifiable agent is verified by reading its tools back.
  assert.ok(body.includes("agentToolsUpdateScoped"));
  assert.ok(body.includes("не сохранила tool Claude"));
  const update = body.indexOf("agentToolsUpdateScoped");
  const readback = body.indexOf("agentGetScoped", update);
  assert.ok(readback > update, "the tool list must be re-read after the write");
});
