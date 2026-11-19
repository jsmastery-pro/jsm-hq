// Boards, tasks, assignments and messages. Used by both the Team MCP tools
// (agents) and the browser commands (you), so both follow the same rules.

import { kindOf } from "../src/data/roles";
import type { Board, ReviewVerdict, Task, TaskKind, TaskStatus } from "../src/data/types";
import type { Hub } from "./hub";
import type { ActionItems } from "./actionItems";
import type { Inbox } from "./inbox";

export interface NewTask {
  boardId?: string;
  title: string;
  description?: string;
  files?: string[];
  doneWhen?: string;
  needs?: string[];
  kind?: TaskKind;
  reviewOf?: number | null;
  reviewFor?: string | null;
  reviewRole?: string | null;
}

export type TaskPatch = Partial<Pick<Task, "title" | "description" | "files" | "doneWhen" | "needs" | "status" | "boardId" | "note" | "prNumber" | "verdict">>;

/** Senders that aren't agents: the user, and HQ itself. */
const actor = (id: string) => (id === "you" || id === "hq" ? null : id);

const now = () => new Date().toISOString();

/** A full commit SHA (SHA-1 or SHA-256). Short SHAs aren't accepted: a prefix can be collided on purpose. */
export const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** True when a reviewer's commit is exactly the PR's head. Unknown on either side is false. */
export function sameCommit(reviewed: string | null | undefined, head: string | null | undefined): boolean {
  return !!reviewed && !!head && reviewed.toLowerCase() === head.toLowerCase();
}

export class Planner {
  private seq = 0;
  /** Set by main: the user's action items (Team MCP `ask_user`). */
  actions: ActionItems | null = null;

  constructor(private hub: Hub, private inbox: Inbox) {}

  private get snap() {
    return this.hub.snap;
  }

  task(id: string): Task | undefined {
    return this.snap.tasks.find((t) => t.id.toLowerCase() === id.trim().toLowerCase());
  }

  /** An agent by id or (case-insensitive) name; "lead" means the lead. */
  agentId(ref: string): string | null {
    const r = ref.trim().toLowerCase();
    const team = this.snap.config.team;
    if (r === "lead") return team.find((a) => a.isLead)?.id ?? null;
    return team.find((a) => a.id === r || a.name.toLowerCase() === r)?.id ?? null;
  }

  defaultBoard(): Board {
    const active = this.snap.boards.filter((b) => b.status === "active").sort((a, b) => a.order - b.order);
    if (active[0]) return active[0];
    return this.createBoard("Backlog", "active");
  }

  // ------------------------------------------------------------ boards

  createBoard(title: string, status: Board["status"] = "planned"): Board {
    const clean = title.trim().slice(0, 80) || "Board";
    const base = clean.split(/\s+/).map((w) => w[0]).join("").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3) || "B";
    let id = base;
    for (let i = 2; this.snap.boards.some((b) => b.id === id); i++) id = `${base}${i}`;
    const board: Board = { id, title: clean, status, order: this.snap.boards.length };
    this.snap.boards.push(board);
    this.hub.emit({ type: "board.updated", board: { ...board } });
    this.hub.planChanged();
    return board;
  }

  updateBoard(id: string, patch: Partial<Pick<Board, "title" | "status">>) {
    const board = this.snap.boards.find((b) => b.id === id);
    if (!board) throw new Error(`No board ${id}`);
    if (patch.title?.trim()) board.title = patch.title.trim().slice(0, 80);
    if (patch.status) board.status = patch.status;
    this.hub.emit({ type: "board.updated", board: { ...board } });
    this.hub.planChanged();
    return board;
  }

  // ------------------------------------------------------------ tasks

  createTask(input: NewTask, byId: string): Task {
    const board = input.boardId ? this.snap.boards.find((b) => b.id === input.boardId) : this.defaultBoard();
    if (!board) throw new Error(`No board ${input.boardId}. Boards: ${this.snap.boards.map((b) => b.id).join(", ")}`);
    let n = this.snap.tasks.filter((t) => t.boardId === board.id).length + 1;
    let id = `${board.id}-T${String(n).padStart(2, "0")}`;
    while (this.task(id)) id = `${board.id}-T${String(++n).padStart(2, "0")}`;
    const task: Task = {
      id, boardId: board.id, title: input.title.trim().slice(0, 120), ownerId: null, status: "todo",
      needs: input.needs ?? [], prNumber: null, description: input.description ?? "", files: input.files ?? [], doneWhen: input.doneWhen ?? "", note: null,
      kind: input.kind ?? "build",
      ...(input.kind === "review" ? { reviewOf: input.reviewOf ?? null, reviewFor: input.reviewFor ?? null, reviewRole: input.reviewRole ?? null, verdict: null } : {}),
    };
    this.snap.tasks.push(task);
    this.hub.emit({ type: "task.updated", task: { ...task } });
    this.hub.activity("task.created", actor(byId), `${this.hub.name(byId)} added ${task.id} ${task.title}`);
    this.hub.planChanged();
    return task;
  }

  updateTask(id: string, patch: TaskPatch): Task {
    const task = this.task(id);
    if (!task) throw new Error(`No task ${id}`);
    // A review finishes only through its reviewer's verdict (finishReview); done without one would
    // leave the PR waiting on a review nobody re-opens.
    if (task.kind === "review" && patch.status === "done" && task.status !== "done" && !(patch.verdict ?? task.verdict))
      throw new Error(`${task.id} is a review: it's done when its reviewer gives a verdict (set_my_status done with verdict approve or changes).`);
    Object.assign(task, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    if (task.status === "done") {
      for (const a of this.snap.agents) if (a.currentTaskId === task.id) this.hub.setStatus(a.agentId, { currentTaskId: null });
    }
    this.hub.emit({ type: "task.updated", task: { ...task } });
    this.hub.planChanged();
    return task;
  }

  /** Gives a task to an agent and tells them to start. */
  assign(taskId: string, agentRef: string, byId: string): Task {
    const task = this.task(taskId);
    const agentId = this.agentId(agentRef);
    if (!task) throw new Error(`No task ${taskId}`);
    if (!agentId) throw new Error(`No agent "${agentRef}". Team: ${this.snap.config.team.map((a) => a.id).join(", ")}`);
    const agent = this.hub.cfg(agentId)!;
    // Plan 012: builders build, reviewers review.
    const isReview = task.kind === "review";
    const kind = kindOf(agent);
    if (isReview && kind !== "reviewer") throw new Error(`${task.id} is a review task. Give it to a reviewer: ${this.namesOf("reviewer") || "the team has none"}.`);
    if (!isReview && kind === "reviewer") throw new Error(`${agent.name} is a reviewer and only takes review tasks. Builders: ${this.namesOf("builder") || "none"}.`);
    task.ownerId = agentId;
    if (task.status === "done") task.status = "todo";
    this.hub.emit({ type: "task.updated", task: { ...task } });
    this.hub.setStatus(agentId, { currentTaskId: task.id });
    this.hub.planChanged();
    this.hub.activity("task.assigned", actor(byId), `${this.hub.name(byId)} assigned ${task.id} ${task.title} to ${agent.name}`);
    const by = byId === "you" ? "The user (your human)" : this.hub.name(byId);
    const text = isReview
      ? `${by} assigned you ${task.id}: review PR #${task.reviewOf}. Call the hq get_my_task tool for the details.`
      : `${by} assigned you ${task.id} (${task.title}). Pull main, start ${task.id}. Call the hq get_my_task tool for the details.`;
    this.record(byId, agentId, `Start ${task.id}: ${task.title}`);
    this.inbox.push(agentId, { fromId: byId, kind: "assign", text });
    return task;
  }

  setStatus(agentId: string, status: Extract<TaskStatus, "in-progress" | "blocked" | "in-review" | "done">, note?: string, prNumber?: number, verdict?: ReviewVerdict, commit?: string): Task {
    const task = this.currentTask(agentId);
    if (!task) throw new Error("You have no task. Ask the lead for one.");
    if (task.kind === "review") return this.finishReview(agentId, task, status, note, verdict, commit);
    const claimed = prNumber ? this.snap.pullRequests.find((p) => p.number === prNumber) : undefined;
    if (claimed?.taskId && claimed.taskId !== task.id) throw new Error(`PR #${prNumber} belongs to ${claimed.taskId}, not ${task.id}. Give the number of the PR you opened for ${task.id}.`);
    task.status = status;
    task.note = note?.slice(0, 300) || null;
    if (prNumber) task.prNumber = prNumber;
    if (status === "done") this.hub.setStatus(agentId, { currentTaskId: null });
    else this.hub.setStatus(agentId, { currentTaskId: task.id });
    this.hub.emit({ type: "task.updated", task: { ...task } });
    this.hub.planChanged();
    const name = this.hub.name(agentId);
    const words = { "in-progress": "started", blocked: "is blocked on", "in-review": "sent for review", done: "finished" }[status];
    this.hub.activity(status === "blocked" ? "agent.needs-input" : "task.started", agentId, `${name} ${words} ${task.id}${note ? `: ${note}` : ""}`);
    // Let the lead know when work is blocked or ready for review.
    const lead = this.snap.config.team.find((a) => a.isLead);
    if (lead && lead.id !== agentId && (status === "blocked" || status === "in-review" || status === "done"))
      this.message(agentId, lead.id, `${task.id} ${words}${note ? `: ${note}` : ""}${prNumber ? ` (PR #${prNumber})` : ""}`);
    if (status === "in-review" && task.prNumber) this.requestReviews(task);
    return task;
  }

  // ------------------------------------------------------------ reviews (plan 012)

  private namesOf(kind: "builder" | "reviewer"): string {
    return this.snap.config.team.filter((a) => kindOf(a) === kind).map((a) => a.name).join(", ");
  }

  /** The reviewer roles on the team, each once ("QA", "Security"). */
  private reviewerRoles(): string[] {
    return [...new Set(this.snap.config.team.filter((a) => kindOf(a) === "reviewer").map((a) => a.role))];
  }

  /** Review tasks for a build task's current PR. */
  reviewsFor(buildTaskId: string): Task[] {
    return this.snap.tasks.filter((t) => t.kind === "review" && t.reviewFor === buildTaskId);
  }

  /** The last head commit GitHub reported for a PR, if HQ has seen it. */
  private headOf(prNumber: number | null | undefined): string | undefined {
    return prNumber ? this.snap.pullRequests.find((p) => p.number === prNumber)?.headSha : undefined;
  }

  private reviewText(build: Task, role: string) {
    return {
      title: `Review #${build.prNumber}: ${build.title}`.slice(0, 120),
      description: `${role} review of PR #${build.prNumber} for ${build.id} (${build.title}).${build.description ? `\n\nThe task: ${build.description}` : ""}`,
    };
  }

  /**
   * A builder's PR is ready for review: make sure each reviewer role has a review task for it,
   * and hand it to a free reviewer of that role (or queue it). An existing review re-opens for the
   * same reviewer when it asked for changes and the author sends the PR back, when the task's PR
   * changed number, or when it approved an older commit than the PR's head (`headSha`).
   */
  requestReviews(build: Task, headSha?: string) {
    if (build.kind === "review" || !build.prNumber) return;
    const head = headSha ?? this.headOf(build.prNumber);
    for (const role of this.reviewerRoles()) {
      const existing = this.reviewsFor(build.id).find((t) => t.reviewRole === role);
      if (existing) {
        const moved = existing.reviewOf !== build.prNumber;
        const done = existing.status === "done";
        const changes = done && existing.verdict === "changes";
        const stale = done && existing.verdict === "approve" && !!head && !sameCommit(existing.reviewedSha, head);
        if (!moved && !changes && !stale) continue; // still open, or approved on the current commit
        const why = moved ? `moved to PR #${build.prNumber}` : stale ? `new commits on PR #${build.prNumber}` : `PR #${build.prNumber} is back for review`;
        Object.assign(existing, { ...this.reviewText(build, role), status: "todo", verdict: null, reviewedSha: null, note: null, reviewOf: build.prNumber });
        this.hub.activity("task.created", null, `${existing.id} re-opened: ${why}`);
        const owner = existing.ownerId && this.hub.cfg(existing.ownerId) ? existing.ownerId : null;
        if (owner && !this.busyReviewer(owner, existing.id)) this.assign(existing.id, owner, "hq");
        else {
          existing.ownerId = null;
          this.hub.emit({ type: "task.updated", task: { ...existing } });
          this.placeReview(existing);
        }
        continue;
      }
      const review = this.createTask(
        {
          boardId: build.boardId,
          ...this.reviewText(build, role),
          doneWhen: build.doneWhen,
          kind: "review",
          reviewOf: build.prNumber,
          reviewFor: build.id,
          reviewRole: role,
        },
        "hq",
      );
      this.placeReview(review);
    }
  }

  private busyReviewer(agentId: string, except?: string): boolean {
    return this.snap.tasks.some((t) => t.ownerId === agentId && t.kind === "review" && t.status !== "done" && t.id !== except);
  }

  /** Give a review task to a free reviewer of its role, or leave it queued until one is free. */
  private placeReview(task: Task) {
    const free = this.snap.config.team.find((a) => kindOf(a) === "reviewer" && a.role === task.reviewRole && !this.busyReviewer(a.id));
    if (free) this.assign(task.id, free.id, "hq");
    else this.hub.activity("task.created", null, `${task.id} is waiting for a free ${task.reviewRole} reviewer`);
  }

  /** A reviewer reports on its review task. */
  private finishReview(agentId: string, task: Task, status: "in-progress" | "blocked" | "in-review" | "done", note?: string, verdict?: ReviewVerdict, commit?: string): Task {
    if (status === "in-review") throw new Error("Reviewers don't open PRs. When you've reviewed it, call set_my_status done with a verdict.");
    if (status === "done" && !verdict) throw new Error("Give your verdict: set_my_status done with verdict approve or changes, and a short summary in note.");
    const reviewed = commit?.trim().toLowerCase();
    if (status === "done" && verdict === "approve" && !(reviewed && FULL_SHA.test(reviewed)))
      throw new Error(`To approve, give the full commit you reviewed: commit = \`git rev-parse HEAD\` (not --short) on the PR #${task.reviewOf} checkout.`);
    task.status = status;
    task.note = note?.slice(0, 1500) || null;
    const name = this.hub.name(agentId);
    if (status !== "done") {
      this.hub.setStatus(agentId, { currentTaskId: task.id });
      this.hub.emit({ type: "task.updated", task: { ...task } });
      this.hub.planChanged();
      this.hub.activity(status === "blocked" ? "agent.needs-input" : "task.started", agentId, `${name} ${status === "blocked" ? "is blocked on" : "started"} ${task.id}${note ? `: ${note}` : ""}`);
      return task;
    }
    task.verdict = verdict ?? null;
    // The commit the reviewer actually checked out, not whatever HQ last saw: an approval counts
    // only while the PR's head is that commit, so commits pushed mid-review re-open it.
    task.reviewedSha = reviewed ?? null;
    this.hub.setStatus(agentId, { currentTaskId: null });
    this.hub.emit({ type: "task.updated", task: { ...task } });
    this.hub.planChanged();
    const pr = `PR #${task.reviewOf}`;
    this.hub.activity(verdict === "approve" ? "review.passed" : "review.changes", agentId, `${name} (${task.reviewRole}) ${verdict === "approve" ? "approved" : "asked for changes on"} ${pr}`);
    const build = task.reviewFor ? this.task(task.reviewFor) : undefined;
    if (verdict === "changes" && build) {
      if (build.status === "in-review") {
        build.status = "in-progress";
        this.hub.emit({ type: "task.updated", task: { ...build } });
        this.hub.planChanged();
      }
      if (build.ownerId)
        this.notify(
          build.ownerId,
          `${name} (${task.reviewRole}) reviewed your ${pr} (${build.id}) and asked for changes:\n${note || "See their comment on the PR."}\n\n` +
            `Their comment is on the PR too (\`gh pr view ${task.reviewOf} --comments\`). Fix it on the same branch, push, then call set_my_status in-review with PR ${task.reviewOf} so they re-check.`,
        );
    }
    // Approved a commit that's already behind the PR's head: re-open it now rather than at the next poll.
    const head = this.headOf(task.reviewOf);
    if (verdict === "approve" && build && head && !sameCommit(task.reviewedSha, head)) this.requestReviews(build, head);
    // Free again: take the next queued review of this reviewer's role.
    const role = this.hub.cfg(agentId)?.role;
    if (this.busyReviewer(agentId)) return task; // its review was just re-opened
    const next = this.snap.tasks.find((t) => t.kind === "review" && !t.ownerId && t.status === "todo" && t.reviewRole === role);
    if (next) this.assign(next.id, agentId, "hq");
    return task;
  }

  currentTask(agentId: string): Task | undefined {
    const st = this.hub.status(agentId);
    const byCurrent = st?.currentTaskId ? this.task(st.currentTaskId) : undefined;
    if (byCurrent && byCurrent.ownerId === agentId) return byCurrent;
    const mine = this.snap.tasks.filter((t) => t.ownerId === agentId && t.status !== "done");
    return mine.find((t) => t.status === "in-progress") ?? mine.find((t) => t.status === "todo") ?? mine[0];
  }

  // ------------------------------------------------------------ messages

  /** Records a message, shows it in the office, and delivers it. */
  message(fromId: string, toRef: string, text: string) {
    const toId = this.agentId(toRef);
    if (!toId) throw new Error(`No agent "${toRef}". Team: ${this.snap.config.team.map((a) => a.id).join(", ")}`);
    const clean = text.trim().slice(0, 2000);
    if (!clean) throw new Error("Empty message");
    this.record(fromId, toId, clean);
    this.hub.activity("message", fromId === "you" ? null : fromId, `${this.hub.name(fromId)} → ${this.hub.name(toId)}: ${clean.slice(0, 80)}`);
    this.inbox.push(toId, { fromId, kind: "message", text: clean });
    return toId;
  }

  /** A notice from HQ itself (review results, merges) to one agent. */
  notify(agentId: string, text: string) {
    if (!this.hub.cfg(agentId)) return;
    this.record("hq", agentId, text);
    this.inbox.push(agentId, { fromId: "hq", kind: "notice", text });
  }

  private record(fromId: string, toId: string, text: string) {
    this.seq += 1;
    const msg = { id: `m${Date.now().toString(36)}${this.seq}`, at: now(), fromId, toId, text };
    this.snap.messages = [msg, ...this.snap.messages].slice(0, 100);
    this.hub.emit({ type: "message", message: msg });
  }
}
