import type {
  ActivityEvent,
  AgentMessage,
  AgentPatch,
  AgentStatus,
  Board,
  Environment,
  HqConfig,
  NewAgentInput,
  OfficeSnapshot,
  SbxState,
  RemoveAgentOptions,
  SetupCheckId,
  SetupState,
  WorkspaceInfo,
  ProjectConfig,
  PullRequest,
  SandboxSettings,
  Task,
  WorkflowPatch,
} from "./types";

export type OfficeEvent =
  | { type: "snapshot"; snapshot: OfficeSnapshot }
  | { type: "setup.updated"; setup: SetupState }
  | { type: "sbx.updated"; sbx: SbxState }
  | { type: "workspace.info"; info: WorkspaceInfo }
  | { type: "config.updated"; config: HqConfig }
  | { type: "agent.updated"; agent: AgentStatus }
  | { type: "agent.removed"; agentId: string }
  | { type: "board.updated"; board: Board }
  | { type: "task.updated"; task: Task }
  | { type: "task.removed"; taskId: string }
  | { type: "pr.updated"; pr: PullRequest }
  | { type: "env.updated"; env: Environment }
  | { type: "env.removed"; name: string }
  | { type: "message"; message: AgentMessage }
  | { type: "activity"; event: ActivityEvent }
  | { type: "terminal.output"; agentId: string; data: string };

export type SimSpeed = 1 | 2 | 4;

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "unauthorized";

export interface DataPreset {
  id: string;
  label: string;
}

/** Controls that only exist on the mock source. The UI hides them when absent. */
export interface DevControls {
  presets: DataPreset[];
  loadPreset(id: string): void;
  setSpeed(multiplier: SimSpeed): void;
}

export interface OfficeDataSource {
  connect(onEvent: (e: OfficeEvent) => void, onStatus?: (s: ConnectionStatus) => void): () => void; // returns disconnect

  sendTerminalInput(agentId: string, data: string): void;
  resizeTerminal(agentId: string, cols: number, rows: number): void;
  assignTask(taskId: string, agentId: string): void;
  /** You → an agent, delivered like any Team MCP message. */
  sendMessage(toId: string, text: string): void;

  // agent sessions
  startAgent(id: string): void;
  stopAgent(id: string): void;
  openWorkspace(id: string): void; // opens the agent's folder on the host
  /** Removes and recreates the agent's sandbox (e.g. to apply new CPU/memory). The folder is kept. */
  recreateSandbox(id: string): void;

  // setup checklist
  recheckSetup(): void;
  /** Runs a check's fix command in a visible terminal (output on terminal id `setup:<checkId>`). */
  runSetupFix(id: SetupCheckId): void;

  addAgent(input: NewAgentInput): void;
  updateAgent(id: string, patch: AgentPatch): void;
  /** Stops the agent and removes it from the team; optionally deletes its sandbox and HQ-made folder. Ignored for the lead. */
  removeAgent(id: string, opts?: RemoveAgentOptions): void;
  /** Asks what removing would delete; answered with a `workspace.info` event. */
  inspectWorkspace(id: string): void;
  updateSandbox(agentId: string, patch: Partial<SandboxSettings>): void;
  /** A service key for one agent's sandbox, or every sandbox (agentId null). The value goes to sbx via stdin; HQ never keeps it. */
  setSecret(agentId: string | null, service: string, value: string): void;
  removeSecret(agentId: string | null, service: string): void;
  /** Machine-wide upstream proxy for sandbox traffic (null clears it). */
  setProxy(url: string | null): void;
  /** Creates the agent's env file if needed and opens it in the default editor. */
  openEnvFile(agentId: string): void;
  /** Re-reads policy rules, keys and proxy from sbx. */
  refreshSbx(): void;
  updateWorkflow(patch: WorkflowPatch): void;
  updateProject(patch: Partial<ProjectConfig>): void;
  createBoard(title: string): void;
  updateBoard(id: string, patch: Partial<Pick<Board, "title" | "status">>): void;

  dev?: DevControls;
}
