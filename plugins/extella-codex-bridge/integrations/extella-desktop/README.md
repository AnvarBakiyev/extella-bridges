# Extella Desktop integration

These files are the reusable adapter for the top-right **Codex** button and its one-button installation modal.

- `codex-installer.js` orchestrates preflight, runtime installation, credentials, bridge setup, global Expert registration, agent reconciliation, and verification.
- `codex-account-bridge.js` defines the global Expert and account-wide binding behavior.
- `marketplace.js` renders the modal, progress, success, and actionable error states.

The host application must provide the API surface consumed by these modules and explicitly allow the Expert/run operations they call. The integration should import these files or apply their behavior as a small adapter; do not fork the bridge protocol into the desktop repository.

After a release, update the desktop install constants to:

```text
marketplace: AnvarBakiyev/extella-bridges
plugin: extella-codex-bridge@extella-codex
```

Installation checks are free and model-free. The first real prompt should be a separate user action with clear cost disclosure.
