**_Prototype:_**

A 3D office where you run a team of AI coding agents. Every agent works in its own isolated pod. You talk to them through their real terminals, and the walls show the team's live work: plan, tasks, PRs, reviews, environments.

!image.png

**Runs locally. Works with any repo. Open source.**

---

## **1. Why it exists**

| Problem today                                     | JSM HQ                                                 |
| ------------------------------------------------- | ------------------------------------------------------ |
| Running 3+ agents means juggling terminal windows | One screen, one pod per agent                          |
| You can't see who is working, waiting, or done    | Pods light up by state; the plan wall shows every task |
| Agents with full access on your machine are risky | Each agent runs inside its own Docker Sandbox          |
| You relay messages between agents by hand         | A lead agent assigns work to the others directly       |
| PRs and reviews live in another tab               | PR board with review status, inside the office         |

---

## **2. What you see**

| Area                       | Shows                                                           |
| -------------------------- | --------------------------------------------------------------- |
| **Pods**                   | One glowing glass pod per agent, its live terminal on the front |
| **Lead desk**              | The lead agent's pod, next to the plan wall                     |
| **Plan wall**              | Phases, tasks, owners, status                                   |
| **PR board + review gate** | Open PRs, review status, open review comments                   |
| **Server room**            | One rack per environment, if the project uses them              |

| Pod light | Meaning                          |
| --------- | -------------------------------- |
| Pulsing   | Working                          |
| Red       | Needs you (question or approval) |
| Amber     | Waiting for review               |
| Green     | PR passed review                 |
| Dim       | Idle                             |

**Click a pod** → the camera zooms in and the terminal goes flat and full size, ready to type.

**No characters at desks.** Pods are faster to build, and they make isolation the visual.

---

## **3. How it works**

```
Browser (localhost)
  └── 3D office + terminals + boards
        ▲ WebSocket
        │
JSM HQ server (on your computer, 127.0.0.1 only)
  ├── Agent runner     starts each agent (sandbox or local) in a real terminal
  ├── Hook endpoint    agents report working / needs input / done
  ├── Boss MCP         tools the lead agent uses to manage the team
  ├── Plan reader      docs/plan.md + task files
  ├── GitHub reader    PRs, review status, comments
  └── Env reader       environments (InstaCloud CLI), if present
```

| Part        | Detail                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------- |
| Terminals   | The real Claude Code terminal, streamed to the browser (node-pty + xterm.js). Nothing re-built. |
| Live state  | Claude Code hooks call the HQ server. From inside a sandbox they use `host.docker.internal`.    |
| Persistence | Closing the browser doesn't stop the agents. Reopening shows the session again.                 |
| Data        | Read live from files, GitHub, and CLIs. No database.                                            |
| Fail safe   | If HQ crashes, agents keep running. Any agent can be opened in a normal terminal.               |

---

## **4. Agent modes**

| Mode                  | How an agent runs                                       | Permissions                              | Use for                                          |
| --------------------- | ------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------ |
| **Sandbox** (default) | Its own Docker Sandbox (microVM)                        | Full access allowed — safe inside the VM | Long autonomous builds                           |
| **Local**             | Plain `claude` on your machine, in its own git worktree | Normal permission prompts                | Everyday tasks, machines that can't run microVMs |
| **Cloud** (later)     | A Docker Cloud Sandbox                                  | Full access                              | Keep working with the laptop closed              |

**Safety rule:** HQ allows full access only in Sandbox and Cloud modes. Local mode always keeps permission prompts on.

---

## **5. The boss**

One agent is the lead. It plans, assigns, and coordinates. It writes no app code.

The lead uses the **HQ Boss MCP**, a small tool server inside HQ:

| Tool           | Does                                                              |
| -------------- | ----------------------------------------------------------------- |
| `list_workers` | Who is on the team, and who is free                               |
| `get_status`   | What each agent is doing right now                                |
| `assign_task`  | Sends a task to a developer's terminal: "Pull main, start P1-T03" |

**Automation:** when a review finishes on a PR, HQ tells its owner to fix the comments. The pod lights up and the agent starts.

| Who does what |                                                                                  |
| ------------- | -------------------------------------------------------------------------------- |
| Developers    | Build their tasks; fix review comments on their own PRs                          |
| Lead          | Merge order, conflicts between PRs, comments that were skipped, contract changes |
| Human         | Approves plans, merges, deploys                                                  |

**Not in the Boss MCP:** starting or stopping sandboxes, merging, deploying.

---

## **6. Setting up a project**

HQ detects most things itself. The user only lists the agents.

```json
{
  "repo": "jsmastery-pro/askwell",
  "path": "~/developer/askwell",
  "agentMode": "sandbox",
  "agents": [
    { "name": "john", "role": "lead" },
    { "name": "bob", "role": "developer" },
    { "name": "alice", "role": "developer" }
  ]
}
```

| Feature     | Detected when                                       | Turn off                |
| ----------- | --------------------------------------------------- | ----------------------- |
| Review gate | PRs have a review check (e.g. CodeRabbit)           | `"reviewGate": false`   |
| Server room | The repo is linked to InstaCloud (`.insta/` folder) | `"environments": false` |

---

## **7. Workflow files**

HQ ships templates so any project can work this way.

| File              | Holds                                                            |
| ----------------- | ---------------------------------------------------------------- |
| `CLAUDE.md`       | Team rules every agent follows                                   |
| `ROLE.md`         | Who this agent is (gitignored, different per agent)              |
| `docs/project.md` | What the project is                                              |
| `docs/plan.md`    | Phases (written by humans) + tasks and status (kept by the lead) |
| `docs/tasks/*.md` | One task each: owner, dependencies, allowed files, done-when     |

**Core rules:** one task = one branch = one PR · each task lists the only files its owner may edit · the shared contract is written first, then frozen · humans merge.

---

## **8. Security**

| Rule             | Detail                                                                      |
| ---------------- | --------------------------------------------------------------------------- |
| Localhost only   | Server binds `127.0.0.1`                                                    |
| Token            | Random token per start, required by the browser, hooks, and Boss MCP        |
| No secrets       | HQ never reads `.env` files. Sandboxes get keys from Docker's secret store. |
| Read-only GitHub | HQ only reads PRs, checks, and comments                                     |

---

## **9. What HQ doesn't do**

| Not included                      | Why                                                  |
| --------------------------------- | ---------------------------------------------------- |
| Merging, deploying, editing plans | Humans and agents keep those jobs                    |
| Hosting                           | Local only, for now                                  |
| Plugin system                     | We build the features needed, behind simple settings |
| Embedding GitHub pages            | GitHub blocks it; boards use the API and link out    |

---

## **10. How it differs from existing agent offices**

AI agent offices already exist. The best known is WebDev Cody's Agent Office (MIT, launched late Sep 2026). We build our own and credit it on screen.

|           | Existing agent offices            | JSM HQ                                            |
| --------- | --------------------------------- | ------------------------------------------------- |
| Isolation | Agents run on your machine        | Each agent in its own Docker Sandbox              |
| Team      | Separate sessions                 | A lead with a plan, plus developers               |
| Look      | Characters at desks, or pixel art | Pods and a review gate                            |
| Workflow  | Work on issues                    | Phases, task files, contract, review, merge order |

---

## **11. Build plan**

No publish date. Each gate ends with a decision: continue, or ship what we have.

| Gate               | Build                                                                          | Done when                                                                                          |
| ------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| **G1 — Spike**     | Agent runner (sandbox), terminals in the browser, hook endpoint, `assign_task` | 3 sandboxes run in parallel; hooks reach HQ; the lead assigns a task; a PR opens and gets reviewed |
| **G2 — Engine**    | All server parts + a plain debug page with the raw data                        | A full project phase runs through HQ                                                               |
| **G3 — 3D office** | Pods, plan wall, PR board, server room, click-to-zoom                          | Every area shows live data                                                                         |
| **G4 — Release**   | Templates, setup command, README, Local mode                                   | Someone outside the team sets it up from the README alone                                          |

---

## **12. Example: this video**

The AI team builds **Askwell** through JSM HQ. Askwell is an AI support chat widget: a business uploads its product info and gets one `<script>` tag that adds a chat bot to any website.

### **Who uses which sponsor**

| Sponsor              | Used by           | Shows up as                                                                                                 |
| -------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------- |
| **Docker Sandboxes** | JSM HQ            | The pods. Every agent in its own sandbox, full access, keys injected from outside.                          |
| **InstaCloud**       | Askwell           | Askwell's hosting and database, plus a database copy per developer agent. HQ shows them in the server room. |
| **CodeRabbit**       | The team workflow | Reviews every agent PR. HQ shows it at the review gate. Triage and Deep Scan shown in CodeRabbit's own app. |
| **Clerk**            | Askwell           | Askwell's login                                                                                             |
| **PostHog**          | Askwell           | Askwell's analytics and the cost of each AI reply                                                           |
| **Arcjet**           | Askwell           | Protects Askwell's public chat. The finale.                                                                 |

### **The team in the video**

| Agent | Role      | Mode                                   |
| ----- | --------- | -------------------------------------- |
| John  | Lead      | Sandbox, Opus                          |
| Bob   | Developer | Sandbox, Sonnet, own InstaCloud branch |
| Alice | Developer | Sandbox, Sonnet, own InstaCloud branch |

### **Video outline**

| Act             | Content                                                                               |
| --------------- | ------------------------------------------------------------------------------------- |
| 1. The office   | Open JSM HQ. Meet the team. Why each agent needs its own sandbox and database.        |
| 2. Planning     | We break a phase down with John. John assigns tasks through HQ.                       |
| 3. The build    | Pods light up; agents build in parallel (fast-forwarded). Pause only for decisions.   |
| 4. The PR flood | CodeRabbit reviews; developers fix their comments; Triage; John sets the merge order. |
| 5. Ship         | Deep Scan, deploy, the full Askwell flow on a real page                               |
| 6. Attack       | We try to break the widget. Arcjet blocks it. PostHog shows the cost.                 |
| Throughout      | An honest failure log: what broke, and how the team recovered                         |

---

## **13. Future: JSM HQ as a product**

Release it open source with the video. Invest in a product only if real demand shows up.

### **Possible paths**

| Path                      | How it makes money                                                                                            | Effort | Read                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------- |
| **A. Course + templates** | A paid JSM course on building with an AI dev team, plus premium role packs and plan templates. HQ stays free. | Low    | **Most realistic.** Fits JSM's existing business; the video is the funnel. |
| **B. Free core + Pro**    | Free local HQ; paid extras such as team sharing, more agent roles, advanced boards                            | Medium | Needs steady development and support                                       |
| **C. Hosted HQ**          | HQ in the browser, agents in Docker Cloud Sandboxes, monthly subscription                                     | High   | Hardest: infrastructure, auth, security, support. Crowded market.          |

### **Limits for any paid version**

| Limit             | Detail                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic terms   | A product can't offer users a Claude subscription login. Users bring their own API key or run their own `claude` CLI.           |
| Costs on the user | Users pay for their own tokens and cloud sandboxes; pricing sits on top                                                         |
| Market            | Many free tools exist. Vibe Kanban's company shut down on Apr 10, 2026 despite ~27.9k stars, citing no workable business model. |

### **Keep the door open now**

| Choice                              | Why                                                                                                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **License — decide before release** | MIT lets anyone, including competitors, sell a hosted HQ. If path B or C is possible, choose now (e.g. MIT + protected name, or AGPL). An MIT release can't be taken back. |
| **Swappable agent modes**           | Adding Cloud mode later is path C without a rewrite                                                                                                                        |
| **Clean server API**                | The browser talks to the server only through its API, so a hosted version can replace the backend                                                                          |

### **Signals before investing**

| Signal                                   | Meaning                       |
| ---------------------------------------- | ----------------------------- |
| Thousands of GitHub stars and real forks | People use it, not just watch |
| Requests to pay for a hosted version     | Path C demand                 |
| Course sign-ups from the video           | Path A works                  |

---

## **14. Risks**

| Risk                                                  | Plan                                               |
| ----------------------------------------------------- | -------------------------------------------------- |
| Computer memory: each sandbox is a VM                 | Measure in G1; limit the number of agents          |
| Token cost multiplies per agent                       | Lead on Opus, developers on Sonnet; budget per run |
| InstaCloud is brand new (max 10 branches per project) | 3 environments only; rehearse twice; Neon fallback |
| Looks like a copy of Agent Office                     | Own visual language, own code, credit on screen    |
| Scope: two products in one video                      | Hard gates; ship a smaller video if 3D slips       |
| Linux microVM support not confirmed                   | Mac on camera; Local mode for others               |

---

## **15. Decisions for Adrian**

| Decision                           | Recommendation                                      |
| ---------------------------------- | --------------------------------------------------- |
| License                            | Decide before release (see section 13)              |
| Release as an open-source JSM repo | Yes                                                 |
| Product                            | Not now. Path A first; revisit B/C with usage data. |
| Sponsor timing                     | Check whether any agreement expects a date          |
