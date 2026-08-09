#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(SCRIPT_DIR, "..");
const BASE_URL = "https://api.extella.ai";
const AGENT_ID = "agent_extella_alibaba_default";
const EXPERT_NAME = "extella_codex_account_bridge_v2";
const RULE_MARKER = "EXTELLA_CODEX_ROUTING_V4";
const RULE_TEXT =
  `${RULE_MARKER}: Codex mode is inactive by default. A one-off request to ` +
  "call or consult Codex must call Codex once and must not activate continuous " +
  "mode. When the user explicitly asks to start, enter, or switch to a " +
  "continuous Codex dialogue, call Codex and, after a successful call, treat " +
  "Codex mode as active in this Extella chat. While Codex mode is active, " +
  "route every later user message directly to Codex without requiring the " +
  "user to mention Codex again, always reusing the conversation_id returned " +
  "in this same chat. When the user asks to stop, exit, or return from Codex " +
  "mode, do not send that command to Codex; deactivate the mode and reply " +
  "locally. If no conversation_id exists in this chat, omit it so the bridge " +
  "creates a new Codex thread. Never reuse a conversation_id from another " +
  "chat and never summarize or truncate the Codex thread history. For every " +
  "bridge call, use extella_codex_account_bridge_v2 directly when available; " +
  "otherwise call run_expert with name=\"extella_codex_account_bridge_v2\", " +
  "global=true, and params containing prompt, the current conversation_id, and " +
  "execution_profile_id. Use execution_profile_id=\"answer-only\" unless the " +
  "user explicitly selects another profile that the bridge reports as available. " +
  "A saved conversation_id must always keep its original execution_profile_id; " +
  "to change profiles, start a new Codex conversation. Never pass raw runtime, " +
  "tool, retry, filesystem, network, or shell flags through the Expert. " +
  "Never use run_agent, never start another Extella agent, and do not call " +
  "get_expert or search_experts first. Do not call Codex unless the user " +
  "explicitly asks or Codex mode is already active in this chat.";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function launchEnvironment(name) {
  const result = await execFileAsync("/bin/launchctl", ["getenv", name], {
    encoding: "utf8",
  });
  return result.stdout.trim();
}

async function postJson(path, body, token) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": token,
      "X-Profile-Id": "default",
      "X-Agent-Id": AGENT_ID,
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let payload = {};
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error(`${path} returned a non-JSON response`);
    }
  }
  if (!response.ok || payload?.status === "error") {
    throw new Error(
      `${path} failed: ${payload?.message || `HTTP ${response.status}`}`,
    );
  }
  return payload;
}

function expertCode(payload) {
  const candidates = [
    payload,
    payload?.expert,
    payload?.result,
    payload?.data,
    payload?.data?.expert,
    payload?.content,
    payload?.content?.expert,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate.expert_code === "string") {
      return candidate.expert_code;
    }
    if (candidate && typeof candidate.code === "string") {
      return candidate.code;
    }
  }
  return "";
}

function ruleRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload?.content && typeof payload.content === "object") {
    return ruleRows(payload.content);
  }
  for (const key of ["rules", "results", "items", "data", "result"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function ruleText(row) {
  return String(row?.rule ?? row?.text ?? row?.content ?? "");
}

function ruleId(row) {
  return row?.id ?? row?.rule_id ?? null;
}

async function main() {
  const token = await launchEnvironment("EXTELLA_API_TOKEN");
  if (token.length < 8) {
    throw new Error("EXTELLA_API_TOKEN is unavailable in launchctl");
  }
  const code = (
    await readFile(
      resolve(PLUGIN_DIR, "experts", `${EXPERT_NAME}.fython`),
      "utf8",
    )
  ).replace(/\r?\n$/, "");
  const codeHash = sha256(code);

  await postJson(
    "/api/expert/save",
    {
      name: EXPERT_NAME,
      description:
        "Delegate a bounded text task to local Codex and resume an isolated " +
        "conversation for the current Extella chat under a reviewed execution profile.",
      code,
      cspl: "fython",
      global: true,
      kwargs: {
        prompt: "",
        conversation_id: "",
        execution_profile_id: "answer-only",
        max_output_tokens: 2000,
        timeout_ms: 120000,
      },
    },
    token,
  );
  const savedExpert = await postJson(
    "/api/expert/get",
    { name: EXPERT_NAME, global: true },
    token,
  );
  const storedCode = expertCode(savedExpert);
  if (sha256(storedCode) !== codeHash) {
    throw new Error(
      "Expert verification failed after save " +
        `(expected ${code.length}/${codeHash.slice(0, 12)}, ` +
        `received ${storedCode.length}/${sha256(storedCode).slice(0, 12)}, ` +
        `keys ${Object.keys(savedExpert || {}).sort().join(",") || "none"})`,
    );
  }

  const listedRules = await postJson(
    "/api/rules/list",
    { global: true },
    token,
  );
  const existing = ruleRows(listedRules).find((row) =>
    ruleText(row).startsWith(`${RULE_MARKER}:`),
  );
  if (existing && ruleText(existing) !== RULE_TEXT && ruleId(existing) != null) {
    await postJson(
      "/api/rules/update",
      { rule_id: String(ruleId(existing)), rule: RULE_TEXT },
      token,
    );
  } else if (!existing) {
    await postJson(
      "/api/rules/add",
      { rule: RULE_TEXT, global: true },
      token,
    );
  }
  const verifiedRules = await postJson(
    "/api/rules/list",
    { global: true },
    token,
  );
  if (!ruleRows(verifiedRules).some((row) => ruleText(row) === RULE_TEXT)) {
    throw new Error("Routing rule verification failed after save");
  }

  console.log(
    JSON.stringify(
      {
        status: "deployed",
        expert: EXPERT_NAME,
        expert_sha256: codeHash,
        routing_rule: RULE_MARKER,
        global: true,
        model_called: false,
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(`deploy-extella-assets: ${error.message}`);
    process.exitCode = 1;
  });
}

export {
  RULE_MARKER,
  RULE_TEXT,
  expertCode,
  main,
  ruleId,
  ruleRows,
  ruleText,
  sha256,
};
