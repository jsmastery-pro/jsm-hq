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
  SetupCheckId,
  SetupState,
  ProjectConfig,
  PullRequest,
  SandboxSettings,
  Task,
  WorkflowPatch,
} from "./types";

export type OfficeEvent =
  | { type: "snapshot"; snapshot: OfficeSnapshot }
  | { type: "setup.updated"; setup: SetupState }
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
  removeAgent(id: string): void; // ignored for the lead
  updateSandbox(agentId: string, patch: Partial<SandboxSettings>): void;
  /** The value is handed to Docker's secret store and never kept by HQ. */
  setSecret(agentId: string, name: string, value: string): void;
  removeSecret(agentId: string, name: string): void;
  updateWorkflow(patch: WorkflowPatch): void;
  updateProject(patch: Partial<ProjectConfig>): void;
  createBoard(title: string): void;
  updateBoard(id: string, patch: Partial<Pick<Board, "title" | "status">>): void;

  dev?: DevControls;
}
