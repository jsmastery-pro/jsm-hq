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
  ProjectConfig,
  PullRequest,
  SandboxSettings,
  Task,
  WorkflowPatch,
} from "./types";

export type OfficeEvent =
  | { type: "snapshot"; snapshot: OfficeSnapshot }
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
  connect(onEvent: (e: OfficeEvent) => void): () => void; // returns disconnect

  sendTerminalInput(agentId: string, data: string): void;
  assignTask(taskId: string, agentId: string): void;

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
