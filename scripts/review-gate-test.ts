// Headless test of the review gate (plan 012): a PR passes only with every reviewer role's approval
// of its current commit. Run from the repo root:
//   npx tsx scripts/review-gate-test.ts
import { withAgentReviews } from "../server/githubSync";
import { Planner } from "../server/planner";
import type { Hub } from "../server/hub";
import type { Inbox } from "../server/inbox";
import { basicRoleMd, newAgent } from "../server/store";
import type { AgentConfig, PullRequest, Task } from "../src/data/types";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) failed++;
};

const agent = (id: string, role: string, extra: Partial<AgentConfig> = {}): AgentConfig =>
  ({ id, name: id, role, isLead: false, cli: "claude", model: "", mode: "sandbox", color: "", skills: [], roleMd: "", sandbox: {}, workspacePath: null, ...extra }) as AgentConfig;

function world(withQa = true) {
  const team = [agent("lead", "Lead", { isLead: true }), agent("dev", "Developer", { kind: "builder" }), ...(withQa ? [agent("qa", "QA", { kind: "reviewer" })] : [])];
  const snap = {
    config: { team },
    tasks: [] as Task[],
    boards: [{ id: "B", title: "Backlog", status: "active", order: 0 }],
    pullRequests: [] as PullRequest[],
    messages: [] as unknown[],
    agents: team.map((a) => ({ agentId: a.id, currentTaskId: null as string | null })),
  };
  const sent: { to: string; text: string }[] = [];
  const hub = {
    snap,
    emit: () => {},
    activity: () => {},
    planChanged: () => {},
    name: (id: string | null) => id ?? "HQ",
    cfg: (id: string) => team.find((a) => a.id === id),
    status: (id: string) => snap.agents.find((a) => a.agentId === id),
    setStatus: (id: string, p: { currentTaskId: string | null }) => {
      const a = snap.agents.find((x) => x.agentId === id);
      if (a) a.currentTaskId = p.currentTaskId;
    },
  } as unknown as Hub;
  const inbox = { push: (to: string, m: { text: string }) => sent.push({ to, text: m.text }) } as unknown as Inbox;
  const planner = new Planner(hub, inbox);
  const pr = (n: number, extra: Partial<PullRequest> = {}): PullRequest => ({
    number: n, title: `PR ${n}`, taskId: "", authorId: "dev", review: "passed", openComments: 0, mergeable: true, merged: false, openedAt: "", headSha: "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0", ...extra,
  });
  const score = (p: PullRequest) => withAgentReviews(p, snap.tasks, team);
  return { snap, planner, pr, score, sent, team };
}

function buildTask(w: ReturnType<typeof world>) {
  const t = w.planner.createTask({ title: "Login page" }, "lead");
  w.planner.assign(t.id, "dev", "lead");
  return t;
}

// 1. Race: the builder's PR is in review, the tool passed, but HQ hasn't made QA's review task yet.
{
  const w = world();
  const t = buildTask(w);
  const p = w.score(w.pr(5, { taskId: t.id }));
  check("race: no review task yet → not passed", p.review === "reviewing", p.review);
  check("race: shows QA as waiting", p.agentReviews?.some((r) => r.role === "QA" && r.verdict === "pending") === true);
}
// 2. A builder's PR with no task id in the title can't skip reviewers.
{
  const w = world();
  const p = w.score(w.pr(7));
  check("untracked builder PR → not passed", p.review === "reviewing", p.review);
  check("untracked builder PR → note says how to fix", (p.reviewNote ?? "").includes("lead can create"), p.reviewNote ?? "");
}
// 3. With reviewers, no PR is exempt (authorship can't be proven); without them, the tool decides.
{
  const w = world();
  check("PR with no author or task still needs reviewers", w.score(w.pr(8, { authorId: "" })).review === "reviewing");
  const v = world(false);
  const t = buildTask(v);
  check("team without reviewers → tool decides", v.score(v.pr(5, { taskId: t.id })).review === "passed");
}
// 4. Approval is bound to the commit; new commits re-open the review.
{
  const w = world();
  const t = buildTask(w);
  w.snap.pullRequests.push(w.pr(5, { taskId: t.id, headSha: "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0" }));
  w.planner.setStatus("dev", "in-review", undefined, 5);
  const review = w.planner.reviewsFor(t.id)[0];
  check("in-review creates a QA review assigned to qa", review?.ownerId === "qa" && review.reviewOf === 5);
  w.planner.setStatus("qa", "done", "looks good", undefined, "approve", "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0");
  check("verdict records the reviewed commit", review.reviewedSha === "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0", String(review.reviewedSha));
  check("approved on the current commit → passed", w.score(w.pr(5, { taskId: t.id, headSha: "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0" })).review === "passed");
  const pushed = w.score(w.pr(5, { taskId: t.id, headSha: "b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0" }));
  check("new commit → approval no longer counts", pushed.review === "reviewing", pushed.review);
  w.planner.requestReviews(t, "b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0");
  check("new commit → review re-opened for the same reviewer", review.status === "todo" && review.verdict === null && review.ownerId === "qa", `${review.status} ${review.verdict} ${review.ownerId}`);
  check("re-opened reviewer was told", w.sent.filter((m) => m.to === "qa").length === 2);
  w.planner.requestReviews(t, "b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0");
  check("re-open is idempotent while the review is open", w.sent.filter((m) => m.to === "qa").length === 2);
}
// 5. A review can't be lent to another PR.
{
  const w = world();
  const t = buildTask(w);
  w.snap.pullRequests.push(w.pr(5, { taskId: t.id }));
  w.planner.setStatus("dev", "in-review", undefined, 5);
  w.planner.setStatus("qa", "done", "ok", undefined, "approve", "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0");
  const other = w.score(w.pr(7, { headSha: "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0" }));
  check("approval for T's PR #5 doesn't count on untracked PR #7", other.review === "reviewing", other.review);
  // The task moves to a new PR #9: approval of #5 doesn't count there, and the review follows the PR.
  const moved = w.score(w.pr(9, { taskId: t.id, headSha: "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0" }));
  check("task's new PR #9 → not passed on #5's approval", moved.review === "reviewing", moved.review);
  w.planner.updateTask(t.id, { prNumber: 9 });
  w.planner.requestReviews(t, "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0");
  const review = w.planner.reviewsFor(t.id)[0];
  check("review moves to #9 and re-opens", review.reviewOf === 9 && review.status === "todo" && review.title.startsWith("Review #9"), `${review.reviewOf} ${review.status} ${review.title}`);
}
// 6. A builder can't claim another task's PR.
{
  const w = world();
  const t1 = buildTask(w);
  const t2 = w.planner.createTask({ title: "Other" }, "lead");
  w.snap.pullRequests.push(w.pr(11, { taskId: t2.id }));
  let threw = "";
  try {
    w.planner.setStatus("dev", "in-review", undefined, 11);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check("claiming another task's PR is refused", threw.includes(`belongs to ${t2.id}`), threw);
  check("…and the task wasn't changed", w.planner.task(t1.id)?.status === "todo" && !w.planner.task(t1.id)?.prNumber && w.planner.reviewsFor(t1.id).length === 0);
}
// 7. The changes loop still works.
{
  const w = world();
  const t = buildTask(w);
  w.snap.pullRequests.push(w.pr(5, { taskId: t.id }));
  w.planner.setStatus("dev", "in-review", undefined, 5);
  w.planner.setStatus("qa", "done", "button broken", undefined, "changes");
  check("changes → build task back to in-progress", t.status === "in-progress");
  check("changes → PR is changes-requested", w.score(w.pr(5, { taskId: t.id })).review === "changes-requested");
  w.planner.setStatus("dev", "in-review", undefined, 5);
  const review = w.planner.reviewsFor(t.id)[0];
  check("sent back → same reviewer re-opened", review.status === "todo" && review.ownerId === "qa");
}

// 8. The reviewer's own commit decides, not what HQ last polled (no TOCTOU).
{
  const w = world();
  const t = buildTask(w);
  w.snap.pullRequests.push(w.pr(5, { taskId: t.id, headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }));
  w.planner.setStatus("dev", "in-review", undefined, 5);
  const review = w.planner.reviewsFor(t.id)[0];
  let threw = "";
  try {
    w.planner.setStatus("qa", "done", "ok", undefined, "approve");
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check("approve without a commit is refused", threw.includes("commit"), threw);
  // The author pushed bbbbbbb mid-review and HQ polled it; QA approves the commit it actually checked out.
  w.snap.pullRequests[0] = w.pr(5, { taskId: t.id, headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
  w.planner.setStatus("qa", "done", "ok", undefined, "approve", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  check("approval of an older commit doesn't pass the new head", w.score(w.snap.pullRequests[0]).review === "reviewing");
  check("…and re-opens right away for the same reviewer", review.status === "todo" && review.ownerId === "qa", `${review.status} ${review.ownerId}`);
  let short = "";
  try {
    w.planner.setStatus("qa", "done", "ok", undefined, "approve", "bbbbbbb");
  } catch (e) {
    short = e instanceof Error ? e.message : String(e);
  }
  check("short SHA is refused (a prefix can be collided)", short.includes("full commit"), short);
  w.planner.setStatus("qa", "done", "ok", undefined, "approve", "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
  check("full SHA of the head, any case → passed", w.score(w.snap.pullRequests[0]).review === "passed");
}
// 9. A re-opened reviewer isn't also handed the next queued review.
{
  const w = world();
  const t1 = buildTask(w);
  w.snap.pullRequests.push(w.pr(5, { taskId: t1.id, headSha: "cccccccccccccccccccccccccccccccccccccccc" }));
  w.planner.setStatus("dev", "in-review", undefined, 5);
  const t2 = w.planner.createTask({ title: "Second" }, "lead");
  w.planner.task(t2.id)!.prNumber = 6;
  w.planner.requestReviews(w.planner.task(t2.id)!);
  const queued = w.planner.reviewsFor(t2.id)[0];
  check("second review queued while qa is busy", !queued.ownerId);
  w.snap.pullRequests[0] = w.pr(5, { taskId: t1.id, headSha: "dddddddddddddddddddddddddddddddddddddddd" });
  w.planner.setStatus("qa", "done", "ok", undefined, "approve", "cccccccccccccccccccccccccccccccccccccccc");
  check("qa keeps the re-opened review, the queued one waits", w.planner.reviewsFor(t1.id)[0].ownerId === "qa" && !queued.ownerId);
}
// 10. Unlinked PRs: only reviews made for no task count (the lead's), and a bogus task id doesn't help.
{
  const w = world();
  const hand = w.planner.createTask({ title: "Review #7", kind: "review", reviewOf: 7, reviewRole: "QA" }, "lead");
  w.planner.assign(hand.id, "qa", "lead");
  w.planner.setStatus("qa", "done", "ok", undefined, "approve", "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
  check("lead's review of an unlinked PR counts", w.score(w.pr(7, { headSha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" })).review === "passed");
  check("PR naming a missing task takes the unlinked review too", w.score(w.pr(7, { taskId: "ZZ-T99", headSha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" })).review === "passed");
  check("PR naming a review task is treated as unlinked", w.score(w.pr(7, { taskId: hand.id, headSha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" })).review === "passed");
  check("unlinked review doesn't count on another PR", w.score(w.pr(70, { headSha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" })).review === "reviewing");
}

// 11. The tool's own note survives rescoring a cached PR.
{
  const w = world();
  const t = buildTask(w);
  const fresh = w.pr(5, { taskId: t.id, headSha: "f".repeat(40), reviewNote: "Greptile: 2 checks pending", review: "reviewing" });
  const first = w.score(fresh);
  check("agent state shown while the tool is still going", first.reviewNote === "Greptile: 2 checks pending");
  w.planner.setStatus("dev", "in-review", undefined, 5);
  w.snap.pullRequests.push(first);
  w.planner.setStatus("qa", "done", "ok", undefined, "approve", "f".repeat(40));
  const passedTool = w.score({ ...w.score({ ...fresh, review: "passed", reviewNote: null }), agentReviews: undefined });
  check("tool passed + approval → passed, no stale agent note", passedTool.review === "passed" && passedTool.reviewNote === null, `${passedTool.review} ${passedTool.reviewNote}`);
  const waiting = w.score({ ...fresh, review: "passed", reviewNote: null, headSha: "9".repeat(40) });
  const rescored = w.score({ ...waiting, headSha: "f".repeat(40) });
  check("rescore of a cached PR restores the tool's note", waiting.reviewNote?.startsWith("Waiting for QA") === true && rescored.reviewNote === null, `${waiting.reviewNote} / ${rescored.reviewNote}`);
}
// 12. update_task can't finish a review without a verdict; build tasks still can.
{
  const w = world();
  const t = buildTask(w);
  w.snap.pullRequests.push(w.pr(5, { taskId: t.id, headSha: "1".repeat(40) }));
  w.planner.setStatus("dev", "in-review", undefined, 5);
  const review = w.planner.reviewsFor(t.id)[0];
  let threw = "";
  try {
    w.planner.updateTask(review.id, { status: "done" });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check("review done without verdict is refused, before any change", threw.includes("verdict") && review.status !== "done", threw);
  check("build task can still be marked done", w.planner.updateTask(t.id, { status: "done" }).status === "done");
}
// 13. A chosen custom kind wins over a catalog match, without the other kind's preset.
{
  const qaBuilder = newAgent("q", "Q", "QA", "", false, "builder");
  check("Custom role named QA as builder stays a builder", qaBuilder.kind === "builder");
  check("…with the plain builder ROLE.md, not the QA reviewer preset", qaBuilder.roleMd === basicRoleMd("Q", "QA", "builder"));
  check("catalog QA without a custom kind is a reviewer", newAgent("q2", "Q2", "QA", "", false).kind === "reviewer");
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
