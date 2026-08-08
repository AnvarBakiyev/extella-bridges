import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createServer } from "node:http";

import {
  invokeProvider,
  safeProviderDiagnostic,
} from "./invoke-provider.mjs";

const LOOPBACK_ADDRESSES = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);
const PROVIDERS = new Set(["mock", "codex"]);
const REQUEST_KEYS_V1 = new Set([
  "schema_version",
  "event_id",
  "agent_id",
  "capability",
  "provider",
  "prompt",
  "budget",
]);
const REQUEST_KEYS_V1_1 = new Set([
  "schema_version",
  "event_id",
  "account_binding",
  "capability",
  "provider",
  "prompt",
  "budget",
]);
const REQUEST_KEYS_V1_2 = new Set([
  ...REQUEST_KEYS_V1_1,
  "conversation_id",
]);
const BUDGET_KEYS = new Set(["max_output_tokens", "timeout_ms"]);
const EVENT_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const AGENT_ID = /^agent_[A-Za-z0-9_-]{8,128}$/;
const ACCOUNT_BINDING = /^[a-f0-9]{64}$/;
const CONVERSATION_ID = /^ctx_[A-Za-z0-9_-]{32,64}$/;
const CAPABILITY = /^[a-z][a-z0-9-]{1,63}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const SIGNATURE = /^sha256=([a-f0-9]{64})$/;
const PROVIDER_ERROR_MESSAGES = new Map([
  [
    "codex_output_budget_exceeded",
    "Codex completed the task, but its answer exceeded max_output_tokens",
  ],
  ["codex_timed_out", "Codex did not finish before timeout_ms"],
  [
    "codex_conversation_not_found",
    "This Extella chat no longer has a saved local Codex conversation",
  ],
  ["codex_chatgpt_auth_required", "Codex must be signed in with ChatGPT"],
  [
    "codex_configuration_incompatible",
    "The local Codex configuration is incompatible with the bridge",
  ],
]);

class BridgeError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new BridgeError(400, "invalid_request", `${label}.${key} is not allowed`);
    }
  }
}

function integer(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new BridgeError(
      400,
      "invalid_request",
      `${label} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value;
}

function normalizeSet(value, label) {
  const normalized =
    value instanceof Set
      ? new Set(value)
      : new Set(Array.isArray(value) ? value : []);
  if (normalized.size === 0) {
    throw new Error(`${label} must contain at least one value`);
  }
  return normalized;
}

function normalizeOptionalSet(value) {
  return value instanceof Set
    ? new Set(value)
    : new Set(Array.isArray(value) ? value : []);
}

function normalizeConfig(options) {
  if (
    typeof options.secret !== "string" ||
    Buffer.byteLength(options.secret, "utf8") < 32
  ) {
    throw new Error("EXTELLA_BRIDGE_SECRET must contain at least 32 bytes");
  }
  const allowedAgentIds = normalizeOptionalSet(options.allowedAgentIds);
  const allowedAccountBindings = normalizeOptionalSet(
    options.allowedAccountBindings,
  );
  if (allowedAgentIds.size === 0 && allowedAccountBindings.size === 0) {
    throw new Error(
      "At least one agent or account authorization binding is required",
    );
  }
  for (const binding of allowedAccountBindings) {
    if (!ACCOUNT_BINDING.test(binding)) {
      throw new Error("Account binding allowlist contains an invalid value");
    }
  }
  const allowedCapabilities = normalizeSet(
    options.allowedCapabilities,
    "Capability allowlist",
  );
  const allowedProviders = normalizeSet(
    options.allowedProviders || ["mock"],
    "Provider allowlist",
  );
  for (const provider of allowedProviders) {
    if (!PROVIDERS.has(provider)) {
      throw new Error(`Unsupported provider in allowlist: ${provider}`);
    }
  }
  const logDiagnostic =
    options.logDiagnostic ||
    ((record) => console.error(JSON.stringify(record)));
  if (typeof logDiagnostic !== "function") {
    throw new Error("Diagnostic logger must be a function");
  }
  return {
    secret: options.secret,
    allowedAgentIds,
    allowedAccountBindings,
    allowedCapabilities,
    allowedProviders,
    freshnessSeconds: options.freshnessSeconds ?? 300,
    maxPromptChars: options.maxPromptChars ?? 4000,
    maxOutputTokens: options.maxOutputTokens ?? 2000,
    maxTimeoutMs: options.maxTimeoutMs ?? 120000,
    maxRequestBytes: options.maxRequestBytes ?? 64 * 1024,
    workspace: options.workspace || process.cwd(),
    stateDir: options.stateDir,
    live: options.live === true,
    now: options.now || (() => Date.now()),
    invoke: options.invoke || invokeProvider,
    logDiagnostic,
  };
}

function signingPayload(timestamp, nonce, rawBody) {
  return Buffer.concat([
    Buffer.from(`${timestamp}.${nonce}.`, "utf8"),
    rawBody,
  ]);
}

function contextBinding(config, delegation) {
  if (delegation.account_binding) {
    return delegation.account_binding;
  }
  return createHmac("sha256", config.secret)
    .update(`extella-agent-context-v1.${delegation.agent_id}`, "utf8")
    .digest("hex");
}

function signRequest({ secret, timestamp, nonce, rawBody }) {
  const body = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(rawBody, "utf8");
  const digest = createHmac("sha256", secret)
    .update(signingPayload(timestamp, nonce, body))
    .digest("hex");
  return `sha256=${digest}`;
}

function verifySignature({
  config,
  nonce,
  nonceCache,
  rawBody,
  signature,
  timestamp,
}) {
  if (!/^\d{10}$/.test(timestamp || "")) {
    throw new BridgeError(401, "unauthorized", "Invalid timestamp");
  }
  if (!NONCE.test(nonce || "")) {
    throw new BridgeError(401, "unauthorized", "Invalid nonce");
  }
  const signatureMatch = (signature || "").match(SIGNATURE);
  if (!signatureMatch) {
    throw new BridgeError(401, "unauthorized", "Invalid signature");
  }
  const timestampMs = Number.parseInt(timestamp, 10) * 1000;
  if (
    Math.abs(config.now() - timestampMs) >
    config.freshnessSeconds * 1000
  ) {
    throw new BridgeError(401, "stale_request", "Request timestamp is stale");
  }
  const expected = signRequest({
    secret: config.secret,
    timestamp,
    nonce,
    rawBody,
  });
  const actualBytes = Buffer.from(signature, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (
    actualBytes.length !== expectedBytes.length ||
    !timingSafeEqual(actualBytes, expectedBytes)
  ) {
    throw new BridgeError(401, "unauthorized", "Invalid signature");
  }

  const expiry = config.now() - config.freshnessSeconds * 1000;
  for (const [cachedNonce, seenAt] of nonceCache) {
    if (seenAt < expiry) {
      nonceCache.delete(cachedNonce);
    }
  }
  if (nonceCache.has(nonce)) {
    throw new BridgeError(409, "replay_detected", "Nonce was already used");
  }
  nonceCache.set(nonce, config.now());
}

function validateDelegation(value, config) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeError(400, "invalid_request", "Body must be a JSON object");
  }
  const accountScoped = ["1.1", "1.2"].includes(value.schema_version);
  if (!accountScoped && value.schema_version !== "1.0") {
    throw new BridgeError(
      400,
      "invalid_request",
      "schema_version must equal 1.0, 1.1, or 1.2",
    );
  }
  exactKeys(
    value,
    value.schema_version === "1.2"
      ? REQUEST_KEYS_V1_2
      : accountScoped
        ? REQUEST_KEYS_V1_1
        : REQUEST_KEYS_V1,
    "request",
  );
  if (!EVENT_ID.test(value.event_id || "")) {
    throw new BridgeError(400, "invalid_request", "event_id is invalid");
  }
  if (accountScoped) {
    if (!ACCOUNT_BINDING.test(value.account_binding || "")) {
      throw new BridgeError(
        400,
        "invalid_request",
        "account_binding is invalid",
      );
    }
  } else if (!AGENT_ID.test(value.agent_id || "")) {
    throw new BridgeError(400, "invalid_request", "agent_id is invalid");
  }
  if (
    value.schema_version === "1.2" &&
    value.conversation_id !== undefined &&
    !CONVERSATION_ID.test(value.conversation_id)
  ) {
    throw new BridgeError(
      400,
      "invalid_request",
      "conversation_id is invalid",
    );
  }
  if (!CAPABILITY.test(value.capability || "")) {
    throw new BridgeError(400, "invalid_request", "capability is invalid");
  }
  if (!PROVIDERS.has(value.provider)) {
    throw new BridgeError(400, "invalid_request", "provider is invalid");
  }
  if (
    typeof value.prompt !== "string" ||
    value.prompt.trim() === "" ||
    value.prompt.length > config.maxPromptChars
  ) {
    throw new BridgeError(
      400,
      "invalid_request",
      `prompt must contain from 1 to ${config.maxPromptChars} characters`,
    );
  }
  if (
    value.budget === null ||
    typeof value.budget !== "object" ||
    Array.isArray(value.budget)
  ) {
    throw new BridgeError(400, "invalid_request", "budget must be an object");
  }
  exactKeys(value.budget, BUDGET_KEYS, "budget");
  const maxOutputTokens = integer(
    value.budget.max_output_tokens,
    1,
    config.maxOutputTokens,
    "budget.max_output_tokens",
  );
  const timeoutMs = integer(
    value.budget.timeout_ms,
    1000,
    config.maxTimeoutMs,
    "budget.timeout_ms",
  );
  if (
    accountScoped &&
    !config.allowedAccountBindings.has(value.account_binding)
  ) {
    throw new BridgeError(
      403,
      "account_not_allowed",
      "Extella account is not allowed",
    );
  }
  if (!accountScoped && !config.allowedAgentIds.has(value.agent_id)) {
    throw new BridgeError(403, "agent_not_allowed", "agent_id is not allowed");
  }
  if (!config.allowedCapabilities.has(value.capability)) {
    throw new BridgeError(
      403,
      "capability_not_allowed",
      "capability is not allowed",
    );
  }
  if (!config.allowedProviders.has(value.provider)) {
    throw new BridgeError(
      403,
      "provider_not_allowed",
      "provider is not enabled",
    );
  }
  return {
    ...value,
    prompt: value.prompt.trim(),
    budget: {
      max_output_tokens: maxOutputTokens,
      timeout_ms: timeoutMs,
    },
  };
}

async function readBody(request, maximumBytes) {
  const declaredLength = Number.parseInt(
    request.headers["content-length"] || "0",
    10,
  );
  if (Number.isInteger(declaredLength) && declaredLength > maximumBytes) {
    throw new BridgeError(413, "request_too_large", "Request body is too large");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) {
      throw new BridgeError(
        413,
        "request_too_large",
        "Request body is too large",
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(response, statusCode, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function createBridgeServer(options) {
  const config = normalizeConfig(options);
  const nonceCache = new Map();
  let busy = false;

  return createServer(async (request, response) => {
    let diagnosticEventId = null;
    try {
      if (!LOOPBACK_ADDRESSES.has(request.socket.remoteAddress)) {
        throw new BridgeError(403, "loopback_only", "Loopback access only");
      }
      if (request.method === "GET" && request.url === "/health") {
        const authorizationScopes = [];
        if (config.allowedAgentIds.size > 0) {
          authorizationScopes.push("agent");
        }
        if (config.allowedAccountBindings.size > 0) {
          authorizationScopes.push("account");
        }
        sendJson(response, 200, {
          status: "ok",
          live_enabled: config.live,
          providers: [...config.allowedProviders],
          authorization_scopes: authorizationScopes,
        });
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/delegate") {
        throw new BridgeError(404, "not_found", "Route not found");
      }
      if (
        !request.headers["content-type"]
          ?.toLowerCase()
          .startsWith("application/json")
      ) {
        throw new BridgeError(
          415,
          "unsupported_media_type",
          "Content-Type must be application/json",
        );
      }
      const rawBody = await readBody(request, config.maxRequestBytes);
      verifySignature({
        config,
        nonce: request.headers["x-extella-nonce"],
        nonceCache,
        rawBody,
        signature: request.headers["x-extella-signature"],
        timestamp: request.headers["x-extella-timestamp"],
      });
      let parsed;
      try {
        parsed = JSON.parse(rawBody.toString("utf8"));
      } catch {
        throw new BridgeError(400, "invalid_json", "Body is not valid JSON");
      }
      const delegation = validateDelegation(parsed, config);
      diagnosticEventId = delegation.event_id;
      if (busy) {
        throw new BridgeError(
          429,
          "bridge_busy",
          "Only one concurrent delegation is allowed",
        );
      }
      busy = true;
      try {
        const result = await config.invoke({
          provider: delegation.provider,
          prompt: delegation.prompt,
          eventId: delegation.event_id,
          accountBinding: contextBinding(config, delegation),
          conversationId: delegation.conversation_id,
          workspace: config.workspace,
          stateDir: config.stateDir,
          live: config.live,
          maxPromptChars: config.maxPromptChars,
          maxOutputTokens: delegation.budget.max_output_tokens,
          timeoutMs: delegation.budget.timeout_ms,
        });
        if (result.event_id !== delegation.event_id) {
          throw new Error("Provider returned a mismatched event_id");
        }
        sendJson(response, 200, result);
      } finally {
        busy = false;
      }
    } catch (error) {
      const known = error instanceof BridgeError;
      let providerDiagnostic = null;
      if (!known) {
        try {
          providerDiagnostic = safeProviderDiagnostic(
            error,
            diagnosticEventId,
          );
          config.logDiagnostic(providerDiagnostic);
        } catch {
          // Diagnostics must never alter the bridge response path.
        }
      }
      const responseError = known
        ? { code: error.code, message: error.message }
        : {
            code: providerDiagnostic?.code || "provider_failed",
            message:
              PROVIDER_ERROR_MESSAGES.get(providerDiagnostic?.code) ||
              "Provider execution failed",
          };
      if (!known && diagnosticEventId) {
        responseError.diagnostic_id = diagnosticEventId;
      }
      if (!known && providerDiagnostic?.stage) {
        responseError.stage = providerDiagnostic.stage;
      }
      if (
        !known &&
        providerDiagnostic?.details &&
        Object.keys(providerDiagnostic.details).length > 0
      ) {
        responseError.details = providerDiagnostic.details;
      }
      sendJson(response, known ? error.statusCode : 502, {
        schema_version: "1.0",
        status: "failed",
        error: responseError,
      });
    }
  });
}

function createNonce() {
  return randomBytes(18).toString("base64url");
}

export {
  BridgeError,
  createBridgeServer,
  createNonce,
  signRequest,
  validateDelegation,
  verifySignature,
};
