// The Claude Code skill `extella-connect` registers accounts with a Python
// script, while the bridge describes the same format in extella-mcp-accounts.mjs.
// Two implementations of one format drift silently unless something compares
// them — so this test runs both and demands byte-equal results.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  accountHandle,
  agentSuffix,
  bindingName,
  helperFilePath,
  mergeAccountConfig,
  headersHelperScript,
  mcpServerEntry,
  serverName,
  tokenFilePath,
} from "../../extella-claude-bridge/scripts/extella-mcp-accounts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, "../../extella-claude-bridge/skills/extella-connect/scripts/extella_connect.py");

function python(expr) {
  const code = [
    "import importlib.util, json, pathlib, sys",
    `spec = importlib.util.spec_from_file_location("c", ${JSON.stringify(script)})`,
    "c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)",
    `print(json.dumps(${expr}))`,
  ].join("\n");
  return JSON.parse(execFileSync("python3", ["-c", code], { encoding: "utf8" }));
}

const token = "00000000-1111-2222-3333-444444444444";
const home = "/Users/parity";
const agentId = "agent_ParityTest01";

test("the account handle is the same in Python and in the bridge", () => {
  assert.equal(python(`c.account_handle(${JSON.stringify(token)})`), accountHandle(token));
  assert.equal(python(`c.account_handle("  " + ${JSON.stringify(token)} + " ")`), accountHandle(token));
});

test("the server name is the same", () => {
  const handle = accountHandle(token);
  assert.equal(python(`c.server_name(${JSON.stringify(handle)})`), serverName(handle));
});

test("the token file path is the same", () => {
  const handle = accountHandle(token);
  assert.equal(
    python(`str(c.token_file(${JSON.stringify(handle)}, pathlib.Path(${JSON.stringify(home)})))`),
    tokenFilePath(handle, home),
  );
});

test("the headers helper is byte-for-byte the same", () => {
  const handle = accountHandle(token);
  assert.equal(
    python(`c.helper_script(${JSON.stringify(handle)}, ${JSON.stringify(agentId)}, pathlib.Path(${JSON.stringify(home)}))`),
    headersHelperScript(handle, { agentId, home }),
  );
});

test("the MCP server entry is the same", () => {
  const helper = `${home}/.extella/mcp/x.sh`;
  assert.deepEqual(python(`c.server_entry(${JSON.stringify(helper)})`), mcpServerEntry("acct_000000000000", { headersHelperPath: helper }));
});

// Several agents of one account (since 0.6.0): `register --agent <id>`.
const second = "agent_SecondParity01";

test("the agent suffix is the same and is sha256(agent_id)[:8]", () => {
  assert.equal(python(`c.agent_suffix(${JSON.stringify(second)})`), agentSuffix(second));
  assert.match(agentSuffix(second), /^[a-f0-9]{8}$/);
  assert.notEqual(agentSuffix(second), agentSuffix(agentId));
});

test("a chosen agent's server name and helper path are the same", () => {
  const handle = accountHandle(token);
  assert.equal(python(`c.server_name(${JSON.stringify(handle)}, ${JSON.stringify(second)})`), serverName(handle, second));
  assert.equal(serverName(handle, second), `extella_${handle}_${agentSuffix(second)}`);
  assert.equal(
    python(`str(c.helper_file(${JSON.stringify(handle)}, pathlib.Path(${JSON.stringify(home)}), ${JSON.stringify(second)}))`),
    helperFilePath(handle, home, second),
  );
  assert.equal(bindingName(handle), handle);
  assert.equal(python(`c.server_name(${JSON.stringify(handle)})`), serverName(handle, ""));
});

test("a chosen agent's helper reads the account's one token file", () => {
  const handle = accountHandle(token);
  const js = headersHelperScript(handle, { agentId: second, home });
  assert.equal(
    python(`c.helper_script(${JSON.stringify(handle)}, ${JSON.stringify(second)}, pathlib.Path(${JSON.stringify(home)}))`),
    js,
  );
  assert.ok(js.includes(tokenFilePath(handle, home)));
  assert.ok(js.includes(`"X-Agent-Id":"${second}"`));
  assert.ok(!js.includes(token));
});

test("two agents of one account merge side by side, the first untouched", () => {
  const handle = accountHandle(token);
  const first = mergeAccountConfig({}, handle, { headersHelperPath: helperFilePath(handle, home) });
  const both = mergeAccountConfig(first, handle, {
    headersHelperPath: helperFilePath(handle, home, second), chosenAgentId: second,
  });
  assert.deepEqual(Object.keys(both.mcpServers).sort(), [serverName(handle), serverName(handle, second)].sort());
  assert.deepEqual(both.mcpServers[serverName(handle)], first.mcpServers[serverName(handle)]);
  const again = mergeAccountConfig(both, handle, {
    headersHelperPath: helperFilePath(handle, home, second), chosenAgentId: second,
  });
  assert.deepEqual(again, both);
});

test("a malformed agent id is refused by both", () => {
  assert.throws(() => agentSuffix("agent_x"));
  assert.throws(() => agentSuffix("../../etc/passwd"));
  assert.equal(python(`c.register("agent_x")["status"]`), "error");
});

test("the Python registrar's offline selftest passes, several agents included", () => {
  const out = execFileSync("python3", [script, "--selftest"], { encoding: "utf8" });
  assert.match(out, /all checks passed/);
});
