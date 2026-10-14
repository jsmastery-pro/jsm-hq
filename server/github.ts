// Read-only GitHub: one GraphQL query (via the user's `gh` login) and pure
// functions that turn the response into PullRequests with a review state.

import type { PullRequest, ReviewState, ReviewTool } from "../src/data/types";
import { run } from "./lib/exec";

// ---------------------------------------------------------------- query

const PR_FIELDS = `
  number title url headRefName createdAt mergedAt state mergeable isDraft reviewDecision
  reviews(last: 20) { nodes { author { login } state submittedAt } }
  reviewThreads(first: 100) { nodes { isResolved isOutdated comments(first: 1) { nodes { author { login } } } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 50) { nodes {
    __typename
    ... on CheckRun { name status conclusion }
    ... on StatusContext { context state description }
  } } } } } }`;

const QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    open: pullRequests(states: OPEN, first: 30, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }
    merged: pullRequests(states: MERGED, first: 15, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }
  }
}`;

export interface GhPr {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  createdAt: string;
  mergedAt: string | null;
  state: "OPEN" | "MERGED" | "CLOSED";
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  isDraft: boolean;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  reviews: { nodes: { author: { login: string } | null; state: string; submittedAt: string }[] };
  reviewThreads: { nodes: { isResolved: boolean; isOutdated: boolean; comments: { nodes: { author: { login: string } | null }[] } }[] };
  commits: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: Ctx[] } } | null } }[] };
}

type Ctx =
  | { __typename: "CheckRun"; name: string; status: string; conclusion: string | null }
  | { __typename: "StatusContext"; context: string; state: string; description: string | null };

export async function fetchPrs(repo: string): Promise<{ open: GhPr[]; merged: GhPr[] }> {
  const [owner, name] = repo.split("/");
  const r = await run("gh", ["api", "graphql", "-f", `query=${QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`], { timeoutMs: 30_000 });
  if (!r.ok) throw new Error(r.stderr.trim().split("\n")[0] || "gh api failed");
  const data = JSON.parse(r.stdout) as { data?: { repository?: { open: { nodes: GhPr[] }; merged: { nodes: GhPr[] } } }; errors?: { message: string }[] };
  if (!data.data?.repository) throw new Error(data.errors?.[0]?.message ?? "Repository not found");
  return { open: data.data.repository.open.nodes, merged: data.data.repository.merged.nodes };
}

// ---------------------------------------------------------------- review state

/** Each review tool's bot logins and status/check name. */
const BOTS: Record<Exclude<ReviewTool, "human" | "custom">, { logins: string[]; check: RegExp; label: string }> = {
  coderabbit: { logins: ["coderabbitai", "coderabbitai[bot]"], check: /coderabbit/i, label: "CodeRabbit" },
  greptile: { logins: ["greptile-apps", "greptile-apps[bot]"], check: /greptile/i, label: "Greptile" },
  copilot: { logins: ["copilot-pull-request-reviewer", "copilot-pull-request-reviewer[bot]", "Copilot"], check: /copilot/i, label: "Copilot" },
};

export interface ReviewResult {
  review: ReviewState;
  openComments: number;
  note: string | null;
}

const contexts = (pr: GhPr): Ctx[] => pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
const openThreads = (pr: GhPr, logins?: string[]) =>
  pr.reviewThreads.nodes.filter((t) => !t.isResolved && !t.isOutdated && (!logins || logins.includes(t.comments.nodes[0]?.author?.login ?? ""))).length;

export function reviewOf(pr: GhPr, tool: ReviewTool): ReviewResult {
  if (tool === "custom") return { review: "pending", openComments: openThreads(pr), note: "Custom review checks aren't run by HQ yet" };

  if (tool === "human") {
    const decided =
      pr.reviewDecision ??
      [...pr.reviews.nodes].reverse().find((r) => r.state === "APPROVED" || r.state === "CHANGES_REQUESTED")?.state ??
      null;
    const open = openThreads(pr);
    if (decided === "APPROVED") return { review: "passed", openComments: open, note: null };
    if (decided === "CHANGES_REQUESTED") return { review: "changes-requested", openComments: open, note: null };
    return { review: "pending", openComments: open, note: "Waiting for a reviewer" };
  }

  const bot = BOTS[tool];
  const open = openThreads(pr, bot.logins);
  const ctx = contexts(pr).find((c) => bot.check.test(c.__typename === "CheckRun" ? c.name : c.context));
  const pending = ctx && (ctx.__typename === "CheckRun" ? ctx.status !== "COMPLETED" : ctx.state === "PENDING" || ctx.state === "EXPECTED");
  if (pending) return { review: "reviewing", openComments: open, note: null };
  if (open > 0) return { review: "changes-requested", openComments: open, note: null };

  const desc = ctx?.__typename === "StatusContext" ? (ctx.description ?? "") : "";
  if (/rate.?limit|skip|paused|disabled/i.test(desc)) return { review: "pending", openComments: 0, note: `${bot.label}: ${desc.toLowerCase()}` };
  const ok = ctx && (ctx.__typename === "CheckRun" ? ctx.conclusion === "SUCCESS" || ctx.conclusion === "NEUTRAL" : ctx.state === "SUCCESS");
  if (ok) return { review: "passed", openComments: 0, note: null };
  if (ctx) return { review: "changes-requested", openComments: 0, note: `${bot.label} check failed` };
  // No status yet: passed if the bot has already reviewed with nothing open, else still waiting.
  const botReviewed = pr.reviews.nodes.some((r) => bot.logins.includes(r.author?.login ?? ""));
  return botReviewed ? { review: "passed", openComments: 0, note: null } : { review: "pending", openComments: 0, note: `Waiting for ${bot.label}` };
}

// ---------------------------------------------------------------- matching

const TASK_ID = /([A-Z][A-Z0-9]*-T\d+)/i;

/** `[P3-T02] Chat route` → P3-T02; otherwise a task id inside the branch name. */
export function taskIdOf(pr: Pick<GhPr, "title" | "headRefName">): string | null {
  const inTitle = pr.title.match(/\[([A-Z][A-Z0-9]*-T\d+)\]/i);
  if (inTitle) return inTitle[1].toUpperCase();
  const inBranch = pr.headRefName.match(TASK_ID);
  return inBranch ? inBranch[1].toUpperCase() : null;
}

/** `alice/UI-T11-redesign` → alice */
export function branchAgent(branch: string): string | null {
  const m = branch.match(/^([a-z0-9][a-z0-9-]*)\//i);
  return m ? m[1].toLowerCase() : null;
}

export function toPullRequest(pr: GhPr, tool: ReviewTool, reviewEnabled: boolean, taskId: string, authorId: string): PullRequest {
  const merged = pr.state === "MERGED";
  const r = reviewEnabled ? reviewOf(pr, tool) : { review: "passed" as ReviewState, openComments: 0, note: null };
  return {
    number: pr.number,
    title: pr.title,
    taskId,
    authorId,
    review: merged && r.review !== "changes-requested" ? "passed" : r.review,
    openComments: r.openComments,
    mergeable: pr.mergeable === "MERGEABLE",
    merged,
    openedAt: pr.createdAt,
    url: pr.url,
    branch: pr.headRefName,
    closed: pr.state === "CLOSED",
    conflict: pr.mergeable === "CONFLICTING",
    reviewNote: pr.isDraft ? "Draft" : r.note,
  };
}
