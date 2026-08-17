# Extella ↔ Codex Bridge

A standalone, open-source integration that connects Codex and Extella in both directions:

- **Codex → Extella:** Codex uses Extella MCP with each user's own credentials.
- **Extella → Codex:** any current or future Extella agent can explicitly delegate a bounded task to the user's local Codex.

The repository is the canonical home for the bridge runtime, the account-wide Extella Expert, the Codex plugin, and the Extella Desktop button integration.

## One public Extella guide

The development guide has one public entry point: the
[Extella Agent Standards repository](https://github.com/AnvarBakiyev/extella-agent-standards).
For every real Codex delegation, the local bridge reads that repository's
`store_app/content.json` and `README.md` from fixed public URLs. It treats both
as reference data, strips executable HTML, keeps no local text copy, and
accepts only a strictly newer `версия_содержимого`. Setup, status, and health
checks do not fetch the guide and do not start a model.

Claude Code can use the same public guide through its Extella MCP connection.
It is not a fallback model for the Extella-to-Codex bridge: the reverse route
starts Codex only after the user's explicit request and cost warning.

```mermaid
flowchart LR
  C["Codex"] -->|"Extella MCP"| E["Extella API"]
  A["Any Extella agent"] -->|"global Expert"| X["signed loopback bridge"]
  X -->|"explicit user request"| C
```

## Install the Codex plugin

```bash
codex plugin marketplace add AnvarBakiyev/extella-codex-bridge --ref v0.3.5
codex plugin add extella-codex-bridge@extella-codex
```

Codex then asks the user to authenticate the Extella MCP connection. Credentials are referenced through environment variables and are never stored in this repository.

## Extella Desktop one-button flow

The product button performs an idempotent setup:

1. verifies Codex and Extella locally without calling a model;
2. installs the signed loopback runtime on macOS;
3. derives an account binding from the current Extella account;
4. ensures the global Expert `extella_codex_account_bridge_v2` is available;
5. makes the bridge available to all current and future agents;
6. verifies the resulting configuration without a paid model call.

The reusable UI integration is in [`plugins/extella-codex-bridge/integrations/extella-desktop`](plugins/extella-codex-bridge/integrations/extella-desktop/README.md).

## Calling Codex from Extella

When the user explicitly asks to call Codex, Extella should invoke the global Expert directly:

```text
run_expert(
  name="extella_codex_account_bridge_v2",
  global=true,
  params={
    "prompt": "...",
    "max_output_tokens": 2000,
    "timeout_ms": 120000
  }
)
```

For every later call in that same Extella chat, add the value returned by the
first call:

```text
params={"prompt": "...", "conversation_id": "ctx_..."}
```

Do not use `run_agent` for this route. The bridge Expert is the tool boundary; the requesting agent's own model provider key is not needed by the local Codex bridge.

The first successful call returns an opaque `conversation_id`. Reuse it only
inside the same Extella chat. The local bridge maps it to a persisted Codex
thread and resumes that thread on later calls, so Codex receives its complete
conversation history without Extella resending or summarizing it. A different
Extella chat omits `conversation_id` and therefore receives a separate Codex
thread. Raw Codex thread IDs never leave the local bridge.

For a continuous conversation, say **"Start Codex mode"** once. After the first
successful bridge call, every later message in that Extella chat is routed to
the same Codex thread until you say **"Exit Codex mode"**. A one-off request such
as **"Ask Codex to review this"** does not enable continuous mode.

## Cost behavior

- Installation, health checks, and configuration verification do **not** call an Extella agent or Codex model.
- A real bridge request can consume the user's Codex/ChatGPT plan or configured OpenAI API usage.
- Normal Extella agent execution follows the user's Extella plan.
- `max_output_tokens` is a post-execution usage guard. The current supported maximum is 2000.

## Local development

```bash
cd plugins/extella-codex-bridge
npm test
```

The test suite uses the mock provider and a fake Codex executable. It does not call a paid model.

Current persistent-runtime support is macOS. The protocol and provider adapter are platform-neutral; Windows and Linux service installers can be added separately.
