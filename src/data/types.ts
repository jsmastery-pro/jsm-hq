// Domain types shared by the data source, the store, the office and the HUD.

// ---------------------------------------------------------------- Config

export type PolicyLevel = "open" | "balanced" | "locked";

export interface SandboxSettings {
  policy: PolicyLevel;
  allow: string[]; // extra allowed domains, e.g. "registry.npmjs.org"
  deny: string[]; // blocked domains
  proxy: string | null; // upstream proxy URL
  secrets: string[]; // secret NAMES only — values live in Docker's secret store
}

export type AgentMode = "sandbox" | "local";

export interface AgentConfig {
  id: string; // "john"
  name: string; // "John"
  role: string; // "Lead" | "Developer" | "QA" | anything
  isLead: boolean;
  model: string; // "Opus" | "Sonnet" | "Haiku"
  mode: AgentMode;
  color: string; // hex, used for the robot, owner dots and chips
  skills: string[];
  roleMd: string; // contents of ROLE.md
  sandbox: SandboxSettings;
}

export type ReviewTool = "coderabbit" | "greptile" | "copilot" | "human" | "custom";
export type DeployTool = "instacloud" | "vercel" | "custom";

export interface WorkflowConfig {
  review: { enabled: boolean; tool: ReviewTool; command: string };
  merge: { by: "human" | "lead" };
  deploy: { enabled: boolean; tool: DeployTool; command: string; perAgentEnvironments: boolean };
}

export interface ProjectConfig {
  name: string; // "Askwell"
  repo: string; // "jsmastery-pro/askwell"
  path: string; // "~/developer/askwell"
  hqPort: number; // port sandboxes use to reach HQ via host.docker.internal
}

export interface HqConfig {
  project: ProjectConfig;
  team: AgentConfig[];
  workflow: WorkflowConfig;
}

// ---------------------------------------------------------------- Live state

export type AgentState = "idle" | "working" | "needs-input" | "in-review" | "review-passed";

export interface AgentStatus {
  agentId: string;
  state: AgentState;
  currentTaskId: string | null;
  stateSince: string; // ISO time
  note: string | null; // e.g. "Asking: max PDF size 10 MB or 20 MB?"
}

export type BoardStatus = "active" | "planned" | "done";

export interface Board {
  id: string; // "P3"
  title: string; // "Phase 3 — Knowledge + chat"
  status: BoardStatus;
  order: number;
}

export type TaskStatus = "todo" | "in-progress" | "in-review" | "done" | "blocked";

export interface Task {
  id: string; // "P3-T02"
  boardId: string;
  title: string;
  ownerId: string | null;
  status: TaskStatus;
  needs: string[]; // task IDs
  prNumber: number | null;
}

export type ReviewState = "pending" | "reviewing" | "changes-requested" | "passed";

export interface PullRequest {
  number: number;
  title: string; // "[P3-T02] Chat route"
  taskId: string;
  authorId: string;
  review: ReviewState;
  openComments: number;
  mergeable: boolean;
  merged: boolean;
  openedAt: string;
}

export type EnvironmentStatus = "live" | "deploying" | "sleeping";

export interface Environment {
  name: string; // "main" | agent id
  agentId: string | null;
  url: string;
  status: EnvironmentStatus;
  lastDeployAt: string;
}

/** One message carried by the Team MCP between two agents. */
export interface AgentMessage {
  id: string;
  at: string;
  fromId: string;
  toId: string;
  text: string;
}

export type ActivityType =
  | "task.assigned"
  | "task.started"
  | "task.created"
  | "agent.needs-input"
  | "agent.answered"
  | "message"
  | "pr.opened"
  | "review.started"
  | "review.passed"
  | "review.changes"
  | "pr.merged"
  | "deploy"
  | "config";

export interface ActivityEvent {
  id: string;
  at: string;
  type: ActivityType;
  agentId: string | null;
  text: string;
}

export interface OfficeSnapshot {
  config: HqConfig;
  agents: AgentStatus[];
  boards: Board[];
  tasks: Task[];
  pullRequests: PullRequest[];
  environments: Environment[];
  messages: AgentMessage[]; // newest first, last 100
  activity: ActivityEvent[]; // newest first, last 50
}

// ---------------------------------------------------------------- Inputs

export interface NewAgentInput {
  name: string;
  role: string;
  model: string;
  mode: AgentMode;
}

export type AgentPatch = Partial<
  Pick<AgentConfig, "name" | "role" | "model" | "mode" | "color" | "skills" | "roleMd">
>;

export interface WorkflowPatch {
  review?: Partial<WorkflowConfig["review"]>;
  merge?: Partial<WorkflowConfig["merge"]>;
  deploy?: Partial<WorkflowConfig["deploy"]>;
}
