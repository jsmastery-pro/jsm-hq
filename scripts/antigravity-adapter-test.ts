import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { adapters, localBinary, AGY_MCP_CONFIG, AGY_HOOKS_CONFIG, AGY_RULES_ROLE } from "../server/adapters";
import { handleHook } from "../server/hooks";
import { Hub } from "../server/hub";
import { Inbox } from "../server/inbox";
import type { AgentConfig, HqConfig } from "../src/data/types";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

async function main() {
  console.log("Running Antigravity adapter tests...");

  // 1. Check localBinary and adapters mapping
  assert(localBinary.antigravity === "agy", "localBinary for antigravity must be 'agy'");
  assert(!!adapters.antigravity, "adapters.antigravity must be defined");

  // 2. Launch spec
  const mockAgent: AgentConfig = {
    id: "john",
    name: "John",
    role: "Developer",
    isLead: false,
    cli: "antigravity",
    model: "gemini-3.8-flash-high",
    mode: "local",
    color: "#29adff",
    skills: [],
    roleMd: "You are John.",
    sandbox: { resources: { cpus: null, memoryGb: null }, allow: [], deny: [] },
    workspacePath: null,
  };

  const launchWithModel = adapters.antigravity.launch(mockAgent);
  assert(launchWithModel.sbxAgent === "agy", "sbxAgent must be 'agy'");
  assert(
    launchWithModel.args.join(" ") === "--model gemini-3.8-flash-high",
    `Args with model mismatch: ${launchWithModel.args.join(" ")}`,
  );

  const launchDefault = adapters.antigravity.launch({ ...mockAgent, model: "" });
  assert(launchDefault.args.length === 0, "Default model should pass empty args");

  // 3. Write files
  const tmpDir = mkdtempSync(join(tmpdir(), "jsmhq-agy-test-"));
  try {
    // initialize a dummy git repo so git ls-files works
    execFileSync("git", ["init", "-q"], { cwd: tmpDir });

    const mockCfg: HqConfig = {
      project: { id: "test", name: "test", repo: "org/test", path: tmpDir, hqPort: 7420 },
      team: [mockAgent],
      workflow: {
        review: { enabled: true, tool: "human", command: "" },
        merge: { by: "human" },
        deploy: { enabled: false, tool: "instacloud", command: "", perAgentEnvironments: false },
      },
    };

    await adapters.antigravity.writeFiles(tmpDir, mockAgent, mockCfg, "dummy-token-123");

    // Check .agents/mcp_config.json
    const mcpPath = join(tmpDir, AGY_MCP_CONFIG);
    assert(existsSync(mcpPath), ".agents/mcp_config.json must exist");
    const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
    assert(mcp.mcpServers?.hq?.url === "http://127.0.0.1:7420/mcp", "MCP server URL must point to HQ");
    assert(
      mcp.mcpServers?.hq?.headers?.Authorization === "Bearer dummy-token-123",
      "MCP Authorization header must match",
    );
    assert(mcp.mcpServers?.hq?.headers?.["X-HQ-Agent"] === "john", "MCP X-HQ-Agent header must match");

    // Check .agents/hooks.json
    const hooksPath = join(tmpDir, AGY_HOOKS_CONFIG);
    assert(existsSync(hooksPath), ".agents/hooks.json must exist");
    const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
    const jsmHooks = hooks["jsmhq-hooks"];
    assert(!!jsmHooks?.SessionStart, "SessionStart hook must exist");
    assert(!!jsmHooks?.PreInvocation, "PreInvocation hook must exist");
    assert(!!jsmHooks?.PreToolUse, "PreToolUse hook must exist");
    assert(!!jsmHooks?.PostToolUse, "PostToolUse hook must exist");
    assert(!!jsmHooks?.Stop, "Stop hook must exist");
    assert(!!jsmHooks?.SessionEnd, "SessionEnd hook must exist");

    // Check .agents/rules/jsmhq-role.md
    const rulesPath = join(tmpDir, AGY_RULES_ROLE);
    assert(existsSync(rulesPath), ".agents/rules/jsmhq-role.md must exist");
    const rulesContent = readFileSync(rulesPath, "utf8");
    assert(rulesContent.includes("trigger: always_on"), "Rules file must have always_on trigger");
    assert(rulesContent.includes("John — Developer"), "Rules file must include agent role header");

    // Check GEMINI.md
    const geminiPath = join(tmpDir, "GEMINI.md");
    assert(existsSync(geminiPath), "GEMINI.md must exist when not git-tracked");

    // Check .git/info/exclude
    const excludePath = join(tmpDir, ".git", "info", "exclude");
    assert(existsSync(excludePath), ".git/info/exclude must exist");
    const excludeContent = readFileSync(excludePath, "utf8");
    assert(excludeContent.includes(AGY_MCP_CONFIG), "Exclude must contain mcp_config.json");
    assert(excludeContent.includes(AGY_HOOKS_CONFIG), "Exclude must contain hooks.json");
    assert(excludeContent.includes(AGY_RULES_ROLE), "Exclude must contain rules role");
    assert(excludeContent.includes("GEMINI.md"), "Exclude must contain GEMINI.md");

    // 4. Test handleHook with Antigravity payloads
    const hub = new Hub("test-project", tmpDir, mockCfg, () => {});
    const inbox = new Inbox(hub, async () => true);

    // Test PreInvocation hook
    const preInvoc = handleHook(hub, inbox, "john", "PreInvocation", { lastUserInput: "Fix the build" });
    assert(preInvoc.ok, "PreInvocation hook should succeed");
    assert(hub.status("john")?.state === "working", "Status should be working after PreInvocation");
    assert(hub.status("john")?.note === "Fix the build", "Status note should match user input");

    // Test PreToolUse clearing an Asking note
    hub.setStatus("john", { state: "needs-input", note: "Asking: Approve tool?" });
    const preTool = handleHook(hub, inbox, "john", "PreToolUse", {
      toolCall: { name: "run_command", args: { command: "npm test" } },
    });
    assert(preTool.ok, "PreToolUse hook should succeed");
    assert(hub.status("john")?.state === "working", "Status should be working after PreToolUse");
    assert(hub.status("john")?.note === "Using run_command", "Status note should reflect tool name");

    // Test Stop hook
    const stopRes = handleHook(hub, inbox, "john", "Stop", {});
    assert(stopRes.ok, "Stop hook should succeed");
    assert(hub.status("john")?.state === "idle", "Status should be idle after Stop");

    console.log("All Antigravity adapter tests passed successfully!");
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

void main();
