# Security

## Design

- The reverse bridge listens only on `127.0.0.1`.
- Every delegation request is HMAC-signed, timestamped, and protected from replay.
- Account authorization is a derived binding; the Extella token is never sent to the bridge.
- Provider subprocesses receive a scrubbed environment and no Extella or model API keys.
- Setup and health checks do not call a model.

Never commit Extella tokens, bridge secrets, Codex credentials, or generated LaunchAgent files.

## Reporting a vulnerability

Please report security issues privately to the repository owner instead of opening a public issue. Include reproduction steps and avoid including live credentials.
