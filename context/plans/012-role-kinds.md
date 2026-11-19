## Implementation plan: Role kinds

### What we're building
Roles that change what an agent does, not just its label. Today an agent is either the lead or a worker, and every worker follows the same build rules whatever its role says ("QA" and "Designer" are developers with another name). This adds **reviewer** agents (QA, Security) that test and audit pull requests instead of writing code, a **catalog of roles** with built-in rules, and an automatic review step: when a builder opens a PR, a free reviewer gets a review task for it.

### Decisions
- **Three kinds of agent.** `AgentConfig.kind`: `lead` | `builder` | `reviewer`.
  - `lead`: unchanged (`isLead` stays for older code and config files). Its preset stays HQ's own.
  - `builder`: build tasks only. One task = one branch = one PR, as today.
  - `reviewer`: review tasks only. Never writes code, never opens a PR, never pushes.
- **Roles are a catalog**, plain data in `server/roles.ts` (like the stack catalog). Each entry: id, label, kind, a one-line summary, and a **preset ROLE.md**. Adding a role is an entry, not code.
- **The preset is a starting point.** Picking a role fills the agent's ROLE.md with the preset; the user edits it in Settings → Team exactly as today. HQ's own rules for the kind (task flow, PR flow, never commit for reviewers) live in the generated role, not in the preset, so editing a preset can't break the workflow.
- **Presets are adapted from [agency-agents](https://github.com/msitarzewski/agency-agents)** (MIT, © AgentLand Contributors), credited in `server/roles.ts` and a `THIRD_PARTY_NOTICES.md` with its license text. Each preset keeps the source's identity, mission, critical rules and checklist, and drops what doesn't fit HQ: long code samples and deliverable templates, and any process of its own for branching, PRs, deploys or approvals (HQ's flow wins). Target 2–4k characters each (ROLE.md is capped at 8,000).

  | Role | Kind | Adapted from | Focus |
  |---|---|---|---|
  | Developer | builder | `engineering-senior-developer` | General full-stack building; today's worker rules. |
  | Frontend Developer | builder | `engineering-frontend-developer` | UI, components, accessibility, client performance. |
  | Backend Developer | builder | `engineering-backend-architect` | APIs, data, auth, server performance. |
  | Designer | builder | `design-ui-designer` (+ `design-ux-architect` checklists) | Follows the project's design docs and tokens; UI files only; before/after screenshots in the PR. |
  | Docs | builder | `engineering-technical-writer` | Documentation only; checks every command and link it writes. |
  | DevOps | builder | `engineering-devops-automator` | CI, build, deploy config, env setup; never deploys production. |
  | QA | reviewer | `testing-evidence-collector` + `testing-reality-checker` | Runs the PR, tests the done-when step by step with evidence, defaults to "needs work" until proven. |
  | Code Reviewer | reviewer | `engineering-code-reviewer` | Reads the diff for correctness, maintainability, tests; blockers vs suggestions. |
  | Security | reviewer | `engineering-security-engineer` | Audits the diff against the project's security rules; findings by severity. |
  | Custom | you pick | — | Your role name and kind; empty preset. |

- **Tasks have a kind too.** `Task.kind`: `build` (default) | `review`, and a review task has `reviewOf` (the PR number) and `reviewFor` (the build task id).
  - `assign_task` refuses a mismatch: a review task to a builder, or a build task to a reviewer, with a message saying who can take it.
  - `list_workers` shows each agent's role and kind, so the lead plans with them.
- **HQ creates review tasks automatically.** When a builder's PR opens (set_my_status in-review with a PR number, or the GitHub sync finding a new `[TASK-ID]` PR) and the team has a reviewer:
  - HQ creates `Review #<n>: <task title>` on the same board and assigns it to a free reviewer (idle, no open review task); if none is free, it queues and assigns when one frees up.
  - With several reviewer roles (QA and Security), each gets its own review task for the PR.
  - The lead is told, and can still create review tasks by hand.
- **A PR passes only when both pass:** the review tool (CodeRabbit, Greptile, Copilot, you) and every reviewer agent's review task. The PR stays "reviewing" until both are in.
  - The reviewer gives its verdict to HQ: `set_my_status done` with `verdict: "approve" | "changes"` and a summary. It also writes its findings on the PR as a comment (`gh pr comment`), for the record.
  - **Not GitHub approvals.** Agents use the user's `gh` login, and GitHub doesn't let anyone approve or request changes on their own PR. The verdict lives in HQ.
  - `changes`: HQ sends the summary to the PR's author ("QA found problems on PR #n: …"), the build task goes back to in-progress, and when the author pushes again HQ re-opens the review task for the same reviewer.
- **Reviewers never write code.** Their generated role says so, and their `get_my_task` rules say: check out the PR branch read-only (`gh pr checkout <n>`), test or audit, comment, report the verdict, then `git checkout main`. A fix is always the author's job, or a new build task from the lead.
- **The lead's rules change** only by one line: builders build, reviewers review; HQ handles review tasks, so don't assign them unless you want an extra review.
- **Office:** a reviewer with a review task walks to the review gate and works there while testing. No new art: the gate and robots exist.

### How to build it
1. **Types and config:** `RoleKind`, `AgentConfig.kind`, `Task.kind`/`reviewOf`/`reviewFor`, `PullRequest.agentReviews` (per reviewer: pending / approve / changes). Config migration: `isLead` → `lead`, a role named QA or Security → `reviewer`, anything else → `builder`. Plan file migration: missing `kind` → `build`.
2. **Role catalog:** `server/roles.ts` with the ten entries above, presets adapted from agency-agents, plus `THIRD_PARTY_NOTICES.md` (added to the package `files`). `newAgent` takes its ROLE.md from the role's preset.
3. **Generated role:** `roleMd()` picks base rules by kind and appends the role's own rules. Reviewer tool list drops nothing it needs; their `get_my_task` returns review rules for review tasks.
4. **Planner and Team MCP:** task kind on `create_task`/`update_task`; kind check in `assign()`; `verdict` on `set_my_status` for review tasks; `list_workers` shows kind.
5. **Automatic review tasks:** on in-review with a PR (planner) and on a new matched PR (GitHub sync): create, assign or queue. Re-open on new commits after `changes`. Free-reviewer queue drains when a reviewer finishes.
6. **Combined review state:** `PullRequest.review` is `passed` only when the tool says passed and every agent review is `approve`; `changes` from an agent makes it `changes-requested`. The "passed" notice to the lead and the merge hint wait for both.
7. **UI:** Settings → Team: the role field becomes a picker from the catalog (plus Custom with a kind choice), and each agent row shows its kind. Team cards and the PR drawer show agent reviews next to the tool's ("QA: changes requested", "Security: approved").
8. **Demo data** for `pnpm dev`: a QA agent and a review on one of the mock PRs.
9. **Docs:** `docs/how-it-works.md` (The team, GitHub and reviews) and the README's "How it works".
10. **Live test** (on the host, `pnpm dev:hq` against a throwaway repo): lead + Developer + QA. The lead assigns a task with a done-when the first attempt misses; the Developer opens a PR; HQ assigns QA a review; QA reports `changes`; the Developer gets the summary and pushes; QA re-reviews and approves; the tool passes; only then does the lead get "ready to merge".

- **Done when:**
  - a team with only Developers behaves exactly as today;
  - adding a QA agent makes every new PR get a QA review without anyone creating the task;
  - a PR with the tool passed but QA's `changes` is not ready to merge, and the author gets QA's findings;
  - `assign_task` refuses a build task for QA and a review task for a Developer;
  - a reviewer never commits: its branch is untouched after a review (checked in the live test).

### Not in this plan
- Reviewers fixing code, or opening their own PRs.
- Real GitHub approvals from agents (needs a separate bot account per agent).
- Role-specific skills or MCP servers by default (the Stack and MCP settings already cover this per agent).
- Importing any agency-agents file (or any .md) as a role. Custom roles can paste their own ROLE.md.
- **Team presets** (next plan): ready-made teams built from these roles, for example "Full-stack: Lead + Frontend + Backend + QA" or "Ship safely: Lead + Developer + Code Reviewer + Security", picked in the welcome or Settings → Team.
- Other kinds (for example a planner-only or ops-only kind) until a role needs one.
