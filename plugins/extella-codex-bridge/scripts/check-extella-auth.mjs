#!/usr/bin/env node

const DEFAULT_API_BASE = "https://api.extella.ai";
const DEFAULT_TOKEN_ENV = "EXTELLA_API_TOKEN";
const MAX_RESPONSE_BYTES = 64 * 1024;

function parseArgs(argv) {
  const options = {
    apiBase: DEFAULT_API_BASE,
    tokenEnv: DEFAULT_TOKEN_ENV,
    timeoutMs: 15000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value === "--api-base" && next) {
      options.apiBase = next;
      index += 1;
    } else if (value === "--token-env" && next) {
      options.tokenEnv = next;
      index += 1;
    } else if (value === "--timeout-ms" && next) {
      options.timeoutMs = Number.parseInt(next, 10);
      index += 1;
    } else if (value === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${value}`);
    }
  }
  return options;
}

function validateOptions(options) {
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(options.tokenEnv)) {
    throw new Error("Token environment variable name is invalid");
  }
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 1000 ||
    options.timeoutMs > 60000
  ) {
    throw new Error("Timeout must be from 1000 to 60000 milliseconds");
  }
  const url = new URL(options.apiBase);
  const local =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  if (url.protocol !== "https:" && !local) {
    throw new Error("Extella API base must use HTTPS");
  }
  return url;
}

async function validateExtellaToken({
  token,
  apiBase = DEFAULT_API_BASE,
  fetchImpl = fetch,
  timeoutMs = 15000,
}) {
  if (typeof token !== "string" || token.trim().length < 8) {
    throw new Error("Extella token is missing or too short");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref();
  try {
    const response = await fetchImpl(
      new URL("/api/token/validate", apiBase),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: token.trim() }),
        signal: controller.signal,
      },
    );
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error("Extella validation response is too large");
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(
        `Extella returned a non-JSON validation response (HTTP ${response.status})`,
      );
    }
    if (!response.ok || payload?.valid !== true) {
      throw new Error(`Extella rejected the token (HTTP ${response.status})`);
    }
    return {
      ok: true,
      valid: true,
      user_id: typeof payload.user_id === "string" ? payload.user_id : null,
      token_echoed: false,
      model_called: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: check-extella-auth.mjs " +
        "[--token-env EXTELLA_API_TOKEN] [--api-base https://api.extella.ai]",
    );
    return;
  }
  validateOptions(options);
  const token = process.env[options.tokenEnv];
  if (!token) {
    throw new Error(
      `${options.tokenEnv} is not set. Configure it outside chat and restart Codex.`,
    );
  }
  const result = await validateExtellaToken({
    token,
    apiBase: options.apiBase,
    timeoutMs: options.timeoutMs,
  });
  console.log(
    JSON.stringify(
      {
        ...result,
        credential_source: "environment",
        token_env: options.tokenEnv,
      },
      null,
      2,
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`check-extella-auth: ${error.message}`);
    process.exitCode = 1;
  });
}

export { parseArgs, validateExtellaToken, validateOptions };
