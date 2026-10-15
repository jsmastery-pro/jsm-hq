// Polls GitHub, keeps the office's PRs in sync, and runs the review automations:
// comments → tell the author; passed → tell the lead; merged → task done.

import type { PullRequest } from "../src/data/types";
import { branchAgent, fetchPrs, taskIdOf, toPullRequest } from "./github";
import type { Hub } from "./hub";
import { log } from "./lib/log";
import type { Planner } from "./planner";

const POLL_MS = 20_000;
const label = { coderabbit: "CodeRabbit", greptile: "Greptile", copilot: "Copilot", human: "The reviewer", custom: "The review check" } as const;

export class GitHubSync {
  private prev = new Map<number, PullRequest>();
  private first = true;
  private timer: NodeJS.Timeout | null = null;
  private nudgeTimer: NodeJS.Timeout | null = null;
  private busy = false;
  private lastError: string | null = null;

  constructor(private hub: Hub, private planner: Planner, private repo: string | null) {}

  start() {
    if (!this.repo) {
      log.warn("No GitHub remote: PRs and reviews are off.");
      return;
    }
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
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
    });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Refresh soon (debounced): an agent just opened a PR or finished a turn. */
  nudge(delayMs = 3000) {
    if (!this.repo) return;
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(() => void this.refresh(), delayMs);
  }

  async refresh() {
    if (!this.repo || this.busy) return;
    if (!this.hub.snap.setup.checks.find((c) => c.id === "gh" && c.status === "ok")) return;
    this.busy = true;
    try {
      const { open, merged } = await fetchPrs(this.repo);
      if (this.lastError) log.info("GitHub reachable again");
      this.lastError = null;
      const wf = this.hub.snap.config.workflow;
      const team = new Set(this.hub.snap.config.team.map((a) => a.id));
      const next = [...open, ...merged].map((gh) => {
        const taskId = taskIdOf(gh);
        const task = taskId ? this.planner.task(taskId) : undefined;
        const fromBranch = branchAgent(gh.headRefName);
        const authorId = task?.ownerId ?? (fromBranch && team.has(fromBranch) ? fromBranch : "");
        return toPullRequest(gh, wf.review.tool, wf.review.enabled, task?.id ?? taskId ?? "", authorId);
      });
      // PRs we showed as open that are now neither open nor recently merged were closed.
      const seen = new Set(next.map((p) => p.number));
      for (const old of this.prev.values()) if (!seen.has(old.number) && !old.merged && !old.closed) next.push({ ...old, closed: true });

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
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== this.lastError) log.warn(`GitHub: ${msg}`);
      this.lastError = msg;
    } finally {
      this.busy = false;
    }
  }

  /** Keep the task board in line with its PR. */
  private syncTask(pr: PullRequest) {
    const task = pr.taskId ? this.planner.task(pr.taskId) : undefined;
    if (!task || pr.closed) return;
    if (pr.merged && task.status !== "done") this.planner.updateTask(task.id, { status: "done", prNumber: pr.number });
    else if (!pr.merged && (task.status === "todo" || task.status === "in-progress")) this.planner.updateTask(task.id, { status: "in-review", prNumber: pr.number });
    else if (!pr.merged && task.prNumber !== pr.number) this.planner.updateTask(task.id, { prNumber: pr.number });
  }

  private react(old: PullRequest | undefined, pr: PullRequest) {
    const hub = this.hub;
    const who = pr.authorId || null;
    const tool = label[hub.snap.config.workflow.review.tool];
    const lead = hub.snap.config.team.find((a) => a.isLead);
    const ref = `#${pr.number} ${pr.title}`;

    if (!old && !pr.merged && !pr.closed) hub.activity("pr.opened", who, `${hub.name(who)} opened PR ${ref}`);
    if (pr.closed && !old?.closed) return hub.activity("config", who, `PR #${pr.number} was closed without merging`);

    if (pr.merged && !old?.merged) {
      hub.activity("pr.merged", null, `PR ${ref} was merged`);
      if (lead) this.planner.notify(lead.id, `PR #${pr.number} (${pr.title}) was merged${pr.taskId ? `; ${pr.taskId} is done` : ""}. Assign the next task if anything is waiting.`);
      return;
    }
    if (pr.merged) return;

    if (pr.review === "reviewing" && old?.review !== "reviewing") hub.activity("review.started", null, `${tool} is reviewing #${pr.number}`);

    const newComments = pr.review === "changes-requested" && (old?.review !== "changes-requested" || pr.openComments > (old?.openComments ?? 0));
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
      hub.activity("review.passed", who, `${tool} approved #${pr.number}`);
      if (lead) this.planner.notify(lead.id, `PR #${pr.number} (${pr.title}) by ${hub.name(who)} passed review and is ready to merge.`);
    }

    if (pr.conflict && !old?.conflict && who)
      this.planner.notify(who, `Your PR #${pr.number} has merge conflicts with main. Pull main, rebase or merge it into your branch, fix the conflicts, and push.`);
  }
}
