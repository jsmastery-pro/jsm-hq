// The role catalog (plan 012): what each role does, and its kind. Plain data: adding a role is
// adding an entry here and a preset ROLE.md in server/roles/presets. Presets are adapted from
// agency-agents (MIT); see THIRD_PARTY_NOTICES.md.

import type { AgentConfig, AgentKind } from "./types";

export interface RoleSpec {
  id: string;
  label: string;
  kind: Exclude<AgentKind, "lead">;
  /** One line for the role picker. */
  summary: string;
}

export const ROLES: RoleSpec[] = [
  { id: "developer", label: "Developer", kind: "builder", summary: "Builds features end to end" },
  { id: "frontend", label: "Frontend Developer", kind: "builder", summary: "UI, components, accessibility, client performance" },
  { id: "backend", label: "Backend Developer", kind: "builder", summary: "APIs, data, auth, server performance" },
  { id: "designer", label: "Designer", kind: "builder", summary: "UI to the design docs, with before/after screenshots" },
  { id: "docs", label: "Docs", kind: "builder", summary: "Documentation only; checks every command and link" },
  { id: "devops", label: "DevOps", kind: "builder", summary: "CI, build, deploy config; never deploys production" },
  { id: "qa", label: "QA", kind: "reviewer", summary: "Tests each PR against its done-when, with evidence" },
  { id: "code-reviewer", label: "Code Reviewer", kind: "reviewer", summary: "Reads each PR's diff for bugs, risks and tests" },
  { id: "security", label: "Security", kind: "reviewer", summary: "Audits each PR for security issues by severity" },
];

export const KIND_LABEL: Record<AgentKind, string> = { lead: "Lead", builder: "Builder", reviewer: "Reviewer" };

export function roleById(id: string): RoleSpec | undefined {
  return ROLES.find((r) => r.id === id);
}

/** The catalog role a free-text role name matches, if any ("qa", "QA", "Security"…). */
export function roleByLabel(label: string): RoleSpec | undefined {
  const l = label.trim().toLowerCase();
  return ROLES.find((r) => r.label.toLowerCase() === l || r.id === l);
}

/** An agent's kind. Older configs have no `kind`: the lead is the lead, everyone else builds. */
export function kindOf(a: Pick<AgentConfig, "isLead" | "kind">): AgentKind {
  if (a.isLead) return "lead";
  return a.kind ?? "builder";
}
