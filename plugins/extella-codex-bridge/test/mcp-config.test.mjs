import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mcpConfigUrl = new URL("../.mcp.json", import.meta.url);

test("missing Extella credentials never prevent Codex from starting", async () => {
  const config = JSON.parse(await readFile(mcpConfigUrl, "utf8"));
  const servers = config.mcpServers ?? {};

  assert.ok(servers.extella_primary, "extella_primary must be declared");
  assert.equal(servers.extella_primary.required, false);
  assert.equal(servers.extella_secondary.required, false);
});
