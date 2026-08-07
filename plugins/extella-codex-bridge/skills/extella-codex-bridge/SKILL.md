---
name: extella-codex-bridge
description: Connect Codex to Extella through MCP and operate the explicit, account-wide Extella-to-Codex local bridge.
---

# Extella ↔ Codex Bridge

Use Extella MCP for Codex-to-Extella work. Keep each Extella account in its own MCP connection and environment variable; never reveal or copy credentials into chat, source files, or logs.

For Extella-to-Codex routing:

1. Only call Codex when the user explicitly asks to call, consult, or delegate to Codex.
2. If `extella_codex_account_bridge_v2` is directly available as a tool, call it with the user's request as `prompt`.
3. Otherwise call `run_expert` directly with `name="extella_codex_account_bridge_v2"`, `global=true`, and the request in `params.prompt`.
4. Never use `run_agent` and never start another Extella agent for this route.
5. Do not call `get_expert` or `search_experts` before the direct invocation unless diagnosing a failed direct call.

Use `max_output_tokens=2000` for complex coding tasks and a smaller value for short answers. Use `timeout_ms` no higher than 120000.

Setup, status, health, and verification must not invoke a model. Before any real model test, tell the user that Codex/ChatGPT plan or API usage may be consumed. Never describe installation as paid.

The bridge must remain loopback-only and HMAC-signed. Do not weaken account binding, nonce replay protection, timestamp freshness, subprocess credential scrubbing, or tool/network disabling in the Codex adapter.
