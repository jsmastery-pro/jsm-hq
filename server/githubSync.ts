// Polls GitHub, keeps the office's PRs in sync, and runs the review automations:
// comments → tell the author; passed → tell the lead; merged → task done.

import { kindOf } from "../src/data/roles";
import type { AgentConfig, AgentReview, PullRequest, Task } from "../src/data/types";
import { branchAgent, fetchPrs, OPEN_LIMIT, RateLimited, taskIdOf, toPullRequest } from "./github";
import type { Hub } from "./hub";
import { log } from "./lib/log";
import { sameCommit, type Planner } from "./planner";

const MERGE_CMD = (n: number | string) => `gh pr merge ${n} --squash --delete-branch`;

/** What the lead is told when a PR passes review: merge it, or leave it to the user (Settings → Workflow → Merge). */
export function passedNotice(pr: Pick<PullRequest, "number" | "title">, author: string, by: "human" | "lead"): string {
  const head = `PR #${pr.number} (${pr.title}) by ${author} passed review.`;
  return by === "lead"
    ? `${head} You merge PRs on this project: run \`${MERGE_CMD(pr.number)}\` now. If GitHub refuses (conflicts or failing checks), ask the author to fix it instead. Then assign the next task if anything is waiting.`
    : `${head} It's ready for the user to merge. Don't merge it yourself.`;
}

/** What the lead is told when the user changes who merges, with the PRs already waiting. */
export function mergeByNotice(by: "human" | "lead", waiting: number[]): string {
  if (by === "human") return "The user changed the workflow: the user merges PRs now. Don't merge PRs yourself.";
  const list = waiting.length ? ` These passed review and are waiting: ${waiting.map((n) => `#${n}`).join(", ")}. Merge each with \`${MERGE_CMD("<number>")}\`.` : "";
  return `The user changed the workflow: you now merge PRs once they pass review.${list}`;
}

const MIN_POLL_MS = 20_000; // never more often than this (nudges included)
const MAX_POLL_MS = 5 * 60_000;
const HQ_BUDGET = 1200; // GraphQL points per hour HQ may use; the rest of the 5,000 is left for the agents' gh commands
const LOW_REMAINING = 800; // below this, poll at most every 2 minutes
/**
 * Plan 012: a PR passes only when the review tool and every reviewer agent approve. `toolReview`
 * keeps the tool's own state; `review` is the combined one the office and the lead go by.
 *
 * Fails closed:
 * - With reviewer roles on the team, every open PR needs a review from each role, even before HQ
 *   has created those review tasks. Authorship can't be proven (agents share the user's GitHub
 *   login and pick their branch names), so no PR is exempt.
 * - A review counts only for the PR and build task it was made for. A PR whose title names no
 *   build task (none, a missing one, or a review task) only takes reviews made for no task: the
 *   ones the lead creates by hand.
 * - An approval counts only for the commit the reviewer checked out; new commits make it pending.
 */
export function withAgentReviews(pr: PullRequest, tasks: Task[], team: AgentConfig[]): PullRequest {
  // A cached PR (rescore) carries the combined state; always start again from the tool's own.
  const toolReview = pr.toolReview ?? pr.review;
  const toolNote = pr.toolNote !== undefined ? pr.toolNote : (pr.reviewNote ?? null);
  const plain: PullRequest = { ...pr, toolReview, toolNote, agentReviews: undefined, review: toolReview, reviewNote: toolNote };
  if (pr.merged || pr.closed) return plain;
  const buildTask = pr.taskId ? tasks.find((t) => t.id === pr.taskId && t.kind !== "review") : undefined;
  const linkedTo = buildTask?.id ?? null;
  const reviews = tasks.filter((t) => t.kind === "review" && t.reviewOf === pr.number && (t.reviewFor ?? null) === linkedTo);
  const roles = [...new Set(team.filter((a) => kindOf(a) === "reviewer").map((a) => a.role))];
  const missing = roles.filter((role) => !reviews.some((t) => t.reviewRole === role));
  if (!reviews.length && !missing.length) return plain;

  const agentReviews: AgentReview[] = [
    ...reviews.map((t): AgentReview => {
      const given = t.status === "done" ? t.verdict : null;
      const current = given === "approve" ? sameCommit(t.reviewedSha, pr.headSha) : true;
      return { taskId: t.id, agentId: t.ownerId, role: t.reviewRole ?? "Reviewer", verdict: given && current ? given : "pending" };
    }),
    ...missing.map((role): AgentReview => ({ taskId: `missing:${role}`, agentId: null, role, verdict: "pending" })),
  ];
  const changes = agentReviews.filter((r) => r.verdict === "changes");
  const waiting = agentReviews.filter((r) => r.verdict === "pending");
  let review = toolReview;
  let reviewNote = toolNote;
  if (changes.length) {
    review = "changes-requested";
    reviewNote = `${changes.map((r) => r.role).join(", ")}: changes requested`;
  } else if (waiting.length && toolReview === "passed") {
    review = "reviewing";
    const unlinked = missing.length && !buildTask ? " (no task linked: the lead can create a review task)" : "";
    reviewNote = `Waiting for ${waiting.map((r) => r.role).join(", ")}${unlinked}`;
  }
  return { ...pr, toolReview, toolNote, agentReviews, review, reviewNote };
}

const label = { coderabbit: "CodeRabbit", greptile: "Greptile", copilot: "Copilot", human: "The reviewer", custom: "The review check" } as const;

export class GitHubSync {
  private prev = new Map<number, PullRequest>();
  private first = true;
  private timer: NodeJS.Timeout | null = null;
  private nudgeTimer: NodeJS.Timeout | null = null;
  private busy = false;
  private lastError: string | null = null;
  private lastFetch = 0;
  private interval = MIN_POLL_MS;
  private pausedUntil = 0;

  constructor(private hub: Hub, private planner: Planner, private repo: string | null) {}

  start() {
    if (!this.repo) {
      log.warn("No GitHub remote: PRs and reviews are off.");
      return;
    }
    void this.tick();
    // Check sooner when an agent finishes a turn (it may have run `gh pr create`)
    // or reports a PR with set_my_status in-review.
    let reviewCfg = JSON.stringify(this.hub.snap.config.workflow.review);
    this.hub.subscribe((e) => {
      // A review-settings change re-labels existing PRs; take a fresh baseline
      // instead of treating that as new review activity.
      if (e.type === "config.updated" && JSON.stringify(e.config.workflow.review) !== reviewCfg) {
        reviewCfg = JSON.stringify(e.config.workflow.review);
        this.first = true;
        this.nudge(500);
      }
      if (e.type === "activity" && e.event.type === "agent.answered") this.nudge();
      if (e.type === "task.updated" && e.task.status === "in-review") this.nudge(1500);
      // A reviewer's verdict changes the combined review state right away, without a GitHub poll.
      if (e.type === "task.updated" && e.task.kind === "review") this.rescore();
    });
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
  }

  /** One poll, then schedule the next at the current interval. */
  private async tick() {
    await this.refresh();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), Math.max(this.interval, this.pausedUntil - Date.now()));
  }

  /** Refresh soon (debounced): an agent just opened a PR or finished a turn. Still respects the minimum gap and any pause. */
  nudge(delayMs = 3000) {
    if (!this.repo) return;
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    const wait = Math.max(delayMs, this.lastFetch + MIN_POLL_MS - Date.now(), this.pausedUntil - Date.now());
    this.nudgeTimer = setTimeout(() => void this.refresh(), wait);
  }

  /** Poll often enough to stay within HQ's share of the budget; slow down when it runs low. */
  private pace(rate: { cost: number; remaining: number } | null) {
    if (!rate) return;
    const forBudget = Math.ceil((Math.max(1, rate.cost) * 3_600_000) / HQ_BUDGET);
    const low = rate.remaining < LOW_REMAINING ? 120_000 : 0;
    this.interval = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, forBudget, low));
  }

  async refresh() {
    if (!this.repo || this.busy || Date.now() < this.pausedUntil) return;
    // Never closer together than the minimum gap (a nudge can land right after a regular poll).
    if (Date.now() - this.lastFetch < MIN_POLL_MS - 1000) return;
    if (!this.hub.snap.setup.checks.find((c) => c.id === "gh" && c.status === "ok")) return;
    this.busy = true;
    this.lastFetch = Date.now();
    try {
      const { open, merged, closed, rate } = await fetchPrs(this.repo);
      if (this.lastError) log.info("GitHub reachable again");
      this.lastError = null;
      this.pace(rate);
      const wf = this.hub.snap.config.workflow;
      const team = new Set(this.hub.snap.config.team.map((a) => a.id));
      const next = [...open, ...merged].map((gh) => {
        const taskId = taskIdOf(gh);
        const task = taskId ? this.planner.task(taskId) : undefined;
        const fromBranch = branchAgent(gh.headRefName);
        const authorId = task?.ownerId ?? (fromBranch && team.has(fromBranch) ? fromBranch : "");
        return withAgentReviews(toPullRequest(gh, wf.review.tool, wf.review.enabled, task?.id ?? taskId ?? "", authorId), this.hub.snap.tasks, this.hub.snap.config.team);
      });
      // PRs we showed as open that are now neither open nor recently merged were closed. A full page of
      // open PRs may have left older ones out, so then only the recently-closed list proves it.
      const seen = new Set(next.map((p) => p.number));
      const complete = open.length < OPEN_LIMIT;
      const recentlyClosed = new Set(closed);
      for (const old of this.prev.values())
        if (!seen.has(old.number) && !old.merged && !old.closed) next.push(complete || recentlyClosed.has(old.number) ? { ...old, closed: true } : old);

      for (const pr of next) {
        const old = this.prev.get(pr.number);
        if (JSON.stringify(old) !== JSON.stringify(pr)) this.hub.emit({ type: "pr.updated", pr: { ...pr } });
        if (!this.first) this.react(old, pr);
        this.syncTask(pr);
      }
      this.hub.snap.pullRequests = next;
      this.prev = new Map(next.map((p) => [p.number, p]));
      this.first = false;
    } catch (err) {
      if (err instanceof RateLimited) {
        this.pausedUntil = err.resetAt.getTime() + 5000;
        const at = err.resetAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const msg = `GitHub API rate limit reached (shared with your agents' gh commands). PR sync paused until ${at}.`;
        if (msg !== this.lastError) {
          log.warn(msg);
          this.hub.activity("config", null, msg);
        }
        this.lastError = msg;
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== this.lastError) log.warn(`GitHub: ${msg}`);
      this.lastError = msg;
    } finally {
      this.busy = false;
    }
  }

  /** Re-apply reviewer agents' verdicts to the PRs we already have (no GitHub call). */
  private rescore() {
    if (this.first) return;
    const next = this.hub.snap.pullRequests.map((pr) => withAgentReviews(pr, this.hub.snap.tasks, this.hub.snap.config.team));
    for (const pr of next) {
      const old = this.prev.get(pr.number);
      if (JSON.stringify(old) === JSON.stringify(pr)) continue;
      this.hub.emit({ type: "pr.updated", pr: { ...pr } });
      this.react(old, pr);
    }
    this.hub.snap.pullRequests = next;
    this.prev = new Map(next.map((p) => [p.number, p]));
  }

  /** Keep the task board in line with its PR. */
  private syncTask(pr: PullRequest) {
    const task = pr.taskId ? this.planner.task(pr.taskId) : undefined;
    if (!task || task.kind === "review" || pr.closed) return;
    if (pr.merged) {
      if (task.status !== "done") this.planner.updateTask(task.id, { status: "done", prNumber: pr.number });
      return;
    }
    if ((task.status === "todo" || task.status === "in-progress") && !pr.agentReviews?.some((r) => r.verdict === "changes")) {
      this.planner.updateTask(task.id, { status: "in-review", prNumber: pr.number });
      this.planner.requestReviews(task, pr.headSha);
      return;
    }
    // GitHub, not the agent, decides which PR is the task's. On a new PR number or new commits,
    // requestReviews moves the reviews to that PR and re-opens approvals of an older commit.
    if (task.prNumber !== pr.number) this.planner.updateTask(task.id, { prNumber: pr.number });
    if (task.status === "in-review") this.planner.requestReviews(task, pr.headSha);
  }

  private react(old: PullRequest | undefined, pr: PullRequest) {
    const hub = this.hub;
    const who = pr.authorId || null;
    const tool = label[hub.snap.config.workflow.review.tool];
    const lead = hub.snap.config.team.find((a) => a.isLead);
    const ref = `#${pr.number} ${pr.title}`;

    if (!old && !pr.merged && !pr.closed) hub.activity("pr.opened", who, `${hub.name(who)} opened PR ${ref}`);
    // A PR that names no build task gets no automatic reviews, and it can't pass without them.
    const linked = pr.taskId ? this.planner.task(pr.taskId) : undefined;
    const missing = pr.agentReviews?.filter((r) => r.taskId.startsWith("missing:")).map((r) => r.role) ?? [];
    if (!old && !pr.merged && !pr.closed && (!linked || linked.kind === "review") && missing.length && lead)
      this.planner.notify(
        lead.id,
        `PR #${pr.number} (${pr.title}) isn't linked to a build task, so HQ won't review it by itself and it can't pass review. ` +
          `If it should be merged, create a review task for it for each reviewer role (${missing.join(", ")}): create_task with kind review, reviewOf ${pr.number} and reviewRole, no reviewFor.`,
      );
    if (pr.closed && !old?.closed) return hub.activity("config", who, `PR #${pr.number} was closed without merging`);

    if (pr.merged && !old?.merged) {
      hub.activity("pr.merged", null, `PR ${ref} was merged`);
      if (lead) this.planner.notify(lead.id, `PR #${pr.number} (${pr.title}) was merged${pr.taskId ? `; ${pr.taskId} is done` : ""}. Assign the next task if anything is waiting.`);
      return;
    }
    if (pr.merged) return;

    if (pr.review === "reviewing" && old?.review !== "reviewing") hub.activity("review.started", null, `${tool} is reviewing #${pr.number}`);

    // The tool's comments only; reviewer agents' findings reach the author from the planner.
    const toolNow = pr.toolReview ?? pr.review;
    const toolBefore = old ? (old.toolReview ?? old.review) : undefined;
    const newComments = toolNow === "changes-requested" && (toolBefore !== "changes-requested" || pr.openComments > (old?.openComments ?? 0));
    if (newComments) {
      const n = pr.openComments;
      hub.activity("review.changes", who, `${tool} left ${n || "new"} comment${n === 1 ? "" : "s"} on #${pr.number}`);
      if (who)
        this.planner.notify(
          who,
          `${tool} reviewed your PR #${pr.number} (${pr.title}) and left ${n || "new"} open comment${n === 1 ? "" : "s"}. ` +
            `Read them with \`gh pr view ${pr.number} --comments\` (or the GitHub API), fix them on the same branch, push, and resolve each thread you fixed.`,
        );
    }

    if (pr.review === "passed" && old?.review !== "passed") {
      hub.activity("review.passed", who, pr.agentReviews?.length ? `${tool} and ${pr.agentReviews.map((r) => r.role).join(", ")} approved #${pr.number}` : `${tool} approved #${pr.number}`);
      if (lead) this.planner.notify(lead.id, passedNotice(pr, hub.name(who), hub.snap.config.workflow.merge.by));
    }

    if (pr.conflict && !old?.conflict && who)
      this.planner.notify(who, `Your PR #${pr.number} has merge conflicts with main. Pull main, rebase or merge it into your branch, fix the conflicts, and push.`);
  }
}
