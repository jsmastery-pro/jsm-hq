# JSM HQ — Build Context (UI MVP)

Context for an AI coding agent. Build the **complete JSM HQ interface with mock data and no real backend.** Every piece of data comes from one mock data source that follows the same interface the real backend will use later.

---

## 1. Product

JSM HQ is a local web app: a 3D office where a person runs a team of AI coding agents.

| Concept     | Meaning                                                                     |
| ----------- | --------------------------------------------------------------------------- |
| Agent       | An AI coding agent (Claude Code) with a name and a role                     |
| Pod         | The 3D glass pod an agent works in. Represents its isolated Docker Sandbox. |
| Lead        | One agent who plans and assigns work. Writes no code.                       |
| Developer   | An agent who builds tasks and opens PRs                                     |
| Phase       | A stage of the project plan, e.g. "Phase 3 — Knowledge + chat"              |
| Task        | One unit of work. One owner, one branch, one PR.                            |
| PR          | A GitHub pull request opened by a developer                                 |
| Review gate | Where PRs get reviewed (CodeRabbit in the demo project)                     |
| Environment | A deployed copy of the project: `main` plus one per developer               |

**Demo project for the mock data:** Askwell, an AI support chat widget. Team: John (lead), Bob and Alice (developers).

---

## 2. Scope

| In scope                                      | Out of scope                                           |
| --------------------------------------------- | ------------------------------------------------------ |
| Full 3D office scene                          | Real terminals, `node-pty`, Docker, GitHub, InstaCloud |
| All HUD panels and drawers                    | Any server, API route, or network call                 |
| Mock data source + scripted simulation        | Auth, persistence, database                            |
| A terminal view (xterm.js) fed by fake output | Running real commands                                  |
| Click, zoom, and panel interactions           | Mobile layout (desktop only, min width 1280px)         |

---

## 3. Stack

| Layer           | Choice                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------- |
| Build           | Vite + React 18 + TypeScript (`strict`)                                                   |
| 3D              | `three`, `@react-three/fiber`, `@react-three/drei`, `@react-three/postprocessing` (Bloom) |
| State           | `zustand`                                                                                 |
| UI              | Tailwind CSS                                                                              |
| Terminal        | `@xterm/xterm` + `@xterm/addon-fit`                                                       |
| Animation (HUD) | `framer-motion`                                                                           |
| Package manager | pnpm                                                                                      |

**No external 3D assets.** Build every model from primitives.

---

## 4. Folder structure

```
src/
  main.tsx
  App.tsx                    # Canvas + HUD layers
  data/
    types.ts                 # all domain types (section 5)
    source.ts                # OfficeDataSource interface (section 6)
    mock/
      fixtures.ts            # initial snapshot: agents, phases, tasks, PRs, envs
      timeline.ts            # scripted events (section 7)
      mockSource.ts          # implements OfficeDataSource using fixtures + timeline
      terminalScripts.ts     # fake terminal output per agent
  store/
    office.ts                # zustand store, fed only by the data source
    ui.ts                    # selection, open drawer, camera target, speed
  scene/
    Office.tsx               # composes the scene
    Floor.tsx
    Pod.tsx
    PodScreen.tsx
    PlanWall.tsx
    PrBoard.tsx
    ReviewGate.tsx
    Rabbit.tsx
    ServerRoom.tsx
    Rack.tsx
    Pipe.tsx
    PrToken.tsx
    Labels.tsx
    CameraRig.tsx
    Effects.tsx
  ui/
    TopBar.tsx
    TeamPanel.tsx
    ActivityFeed.tsx
    Drawer.tsx
    AgentDrawer.tsx
    TerminalView.tsx
    PlanDrawer.tsx
    PrDrawer.tsx
    EnvironmentDrawer.tsx
    DebugPanel.tsx
  theme/
    tokens.ts
```

---

## 5. Domain types

```ts
// src/data/types.ts

export type AgentRole = "lead" | "developer";
export type AgentMode = "sandbox" | "local";
export type AgentState =
  | "idle"
  | "working"
  | "needs-input"
  | "in-review"
  | "review-passed";

export interface Agent {
  id: string; // "john"
  name: string; // "John"
  role: AgentRole;
  mode: AgentMode;
  state: AgentState;
  currentTaskId: string | null;
  environment: string | null; // "bob" | "alice" | null for the lead
  model: string; // "Opus" | "Sonnet"
  stateSince: string; // ISO time
  note: string | null; // e.g. "Asking: which embedding model?"
}

export type TaskStatus =
  | "todo"
  | "in-progress"
  | "in-review"
  | "done"
  | "blocked";

export interface Task {
  id: string; // "P3-T02"
  phaseId: string; // "P3"
  title: string; // "Chat route"
  ownerId: string; // "bob"
  status: TaskStatus;
  needs: string[]; // task IDs
  prNumber: number | null;
}

export interface Phase {
  id: string; // "P3"
  title: string; // "Knowledge + chat"
  status: "done" | "current" | "next" | "later";
}

export type ReviewState =
  | "pending"
  | "reviewing"
  | "changes-requested"
  | "passed";

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

export interface Environment {
  name: string; // "main" | "bob" | "alice"
  url: string;
  status: "live" | "deploying" | "sleeping";
  lastDeployAt: string;
}

export type ActivityType =
  | "task.assigned"
  | "task.started"
  | "agent.needs-input"
  | "pr.opened"
  | "review.started"
  | "review.passed"
  | "review.changes"
  | "pr.merged"
  | "deploy";

export interface ActivityEvent {
  id: string;
  at: string;
  type: ActivityType;
  agentId: string | null;
  text: string; // "Bob opened PR #15"
}

export interface OfficeConfig {
  projectName: string; // "Askwell"
  repo: string; // "jsmastery-pro/askwell"
  reviewGate: { enabled: boolean; label: string }; // { true, "CodeRabbit" }
  environments: { enabled: boolean; label: string }; // { true, "InstaCloud" }
}

export interface OfficeSnapshot {
  config: OfficeConfig;
  agents: Agent[];
  phases: Phase[];
  tasks: Task[];
  pullRequests: PullRequest[];
  environments: Environment[];
  activity: ActivityEvent[]; // newest first, keep last 50
}
```

---

## 6. Data source interface

The UI never imports fixtures directly. It only talks to `OfficeDataSource`. Later a real WebSocket source replaces the mock without UI changes.

```ts
// src/data/source.ts
import type { OfficeSnapshot } from "./types";

export type OfficeEvent =
  | { type: "snapshot"; snapshot: OfficeSnapshot }
  | { type: "agent.updated"; agent: import("./types").Agent }
  | { type: "task.updated"; task: import("./types").Task }
  | { type: "pr.updated"; pr: import("./types").PullRequest }
  | { type: "env.updated"; env: import("./types").Environment }
  | { type: "activity"; event: import("./types").ActivityEvent }
  | { type: "terminal.output"; agentId: string; data: string };

export interface OfficeDataSource {
  connect(onEvent: (e: OfficeEvent) => void): () => void; // returns disconnect
  sendTerminalInput(agentId: string, data: string): void; // mock: echo + canned reply
  assignTask(taskId: string, agentId: string): void; // mock: emits task.assigned
  setSpeed(multiplier: 1 | 2 | 4): void; // mock only
}
```

The zustand store applies events to its state. Components read from the store.

---

## 7. Mock simulation

### Fixtures (start state)

| Item          | Values                                                                                                                                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phases        | P0 Setup (done), P1 Foundation (done), P2 Projects + widget (done), P3 Knowledge + chat (current), P4 Conversations + analytics (next), P5 Billing + customize (later), P6 Harden + launch (later)                            |
| P3 tasks      | P3-T01 Knowledge upload · Alice · in-progress · P3-T02 Chat route · Bob · in-progress · P3-T03 PDF text extraction · Alice · todo · P3-T04 Rate limit · Bob · todo · P3-T05 Connect panel to chat · Bob · todo · needs P3-T02 |
| Earlier tasks | ~10 tasks from P0–P2, all `done`, with merged PRs #1–#12                                                                                                                                                                      |
| Agents        | John · lead · Opus · working ("Breaking down Phase 4") · Bob · developer · Sonnet · working · env `bob` · Alice · developer · Sonnet · working · env `alice`                                                                  |
| Environments  | `main` live, `bob` live, `alice` live, with fake URLs like `https://bob-askwell.instacloud.app`                                                                                                                               |

### Timeline (loops every ~90 seconds at 1x speed)

| t (s) | Event                                                                                                 |
| ----- | ----------------------------------------------------------------------------------------------------- |
| 0     | John working. Bob on P3-T02, Alice on P3-T01.                                                         |
| 8     | Alice → `needs-input`, note "Asking: max PDF size 10 MB or 20 MB?"                                    |
| 16    | Alice → `working` (question answered)                                                                 |
| 22    | Bob opens PR #13 `[P3-T02] Chat route` → task `in-review`, Bob `in-review`, PR token leaves Bob's pod |
| 26    | Token reaches the review gate → review `reviewing` (gate amber)                                       |
| 34    | Review `changes-requested`, 3 open comments → Bob `working` ("Fixing review comments")                |
| 44    | Bob pushes fix → review `reviewing` again                                                             |
| 50    | Review `passed`, 0 comments → Bob `review-passed`, gate flashes green                                 |
| 56    | PR #13 merged → token travels to `main` rack, rack pulses → task `done`, `deploy` event               |
| 60    | John assigns P3-T04 to Bob (`task.assigned`) → Bob `working` on P3-T04                                |
| 66    | Alice opens PR #14 `[P3-T01] Knowledge upload` → same review flow, passes at 80                       |
| 88    | Reset task/PR state for the next loop (keep activity history)                                         |

Each state change also emits an `activity` event with readable text.

### Fake terminal output

Per agent, a script of lines written to xterm with realistic pacing (20–80 ms per character for typed lines, instant for tool output). Use Claude Code-like output: tool calls (`Read`, `Edit`, `Bash(pnpm test)`), short reasoning lines, test results, `gh pr create` output. Match the timeline, e.g. Bob shows `gh pr create` near t=22. Use ANSI colors.

---

## 8. Scene

### Coordinates (meters, y up; tune for composition)

| Object            | Position                                                                    | Notes                                            |
| ----------------- | --------------------------------------------------------------------------- | ------------------------------------------------ |
| Floor             | 44 × 28, centered at (2, 0, 0)                                              | Dark, subtle grid                                |
| John's pod (lead) | (-2, 0, -5)                                                                 | 1.3× the dev pod size                            |
| Plan wall         | (-2, 0, -9), facing +z                                                      | 10 wide × 4.5 tall                               |
| Bob's pod         | (-6, 0, 3)                                                                  |                                                  |
| Alice's pod       | (1, 0, 3)                                                                   |                                                  |
| Review gate       | (8, 0, 0)                                                                   | Arch, faces −x                                   |
| PR board          | (8, 0, -5), facing −x                                                       | 5 × 3                                            |
| Server room       | 3 racks at x = 15: `main` (15, 0, -4), `bob` (15, 0, 0), `alice` (15, 0, 4) | Only if `environments.enabled`                   |
| Pipes             | Bob's pod → `bob` rack; Alice's pod → `alice` rack                          | Floor-level curved tubes, routed around the gate |

### Default camera

Perspective, FOV 40, position (20, 17, 20), target (3, 0, 0). Orbit allowed with limits: polar 20°–70°, distance 15–45. No panning below the floor.

### Models (primitives only)

| Model           | Build                                                                                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pod**         | Rounded box (drei `RoundedBox`), 3 × 3.2 × 3, glass (`MeshPhysicalMaterial`: transmission 1, roughness 0.12, thickness 0.6, ior 1.4). Glowing edge outline in the state color. Small base platform. Name label above.  |
| **Pod screen**  | A screen on the front face (drei `<Html transform>`), about 2.4 × 1.4: the last ~12 terminal lines, read-only, monospace, state-colored header bar with name + task ID                                                 |
| **Plan wall**   | A dark panel with a glowing frame. Shows the current phase title, a phase progress strip (P0–P6), and 5 columns of task cards (todo, in progress, in review, done, blocked). Card = task ID + title + owner color dot. |
| **Review gate** | An arch of 2 pillars + a top beam, glowing outline. A light curtain inside the arch, colored by review state. `label` from config on the beam.                                                                         |
| **Rabbit**      | Low-poly white figure on top of the gate: body sphere, head sphere, 2 tall ears (capsules), small tail. Idle: ears twitch. On `passed`: hops once.                                                                     |
| **PR board**    | A panel listing open PRs: number, title, author dot, review chip, open-comment count                                                                                                                                   |
| **Rack**        | A tall box 1.2 × 3 × 1, dark metal, rows of small LEDs that blink. Label on top. Status color: live = green, deploying = cyan blink, sleeping = dim.                                                                   |
| **Pipe**        | `TubeGeometry` along a `CatmullRomCurve3`, emissive cyan, with small light particles moving along the curve                                                                                                            |
| **PR token**    | A glowing sphere/octahedron with the PR number label. Moves pod → gate (waits during review) → `main` rack on merge.                                                                                                   |

### State → visual mapping

| Agent state     | Pod edge   | Effect                                                   |
| --------------- | ---------- | -------------------------------------------------------- |
| `idle`          | slate, dim | none                                                     |
| `working`       | cyan       | slow pulse (2s)                                          |
| `needs-input`   | red        | fast pulse (0.8s) + small red beacon light above the pod |
| `in-review`     | amber      | steady glow                                              |
| `review-passed` | green      | one flash, then steady                                   |

| Review state        | Gate curtain             |
| ------------------- | ------------------------ |
| `pending`           | off                      |
| `reviewing`         | amber shimmer            |
| `changes-requested` | red, 1s                  |
| `passed`            | green flash + rabbit hop |

### Effects

Bloom (`@react-three/postprocessing`, intensity ~0.8, luminance threshold ~0.2) so edges and pipes glow. Soft ambient + one directional light. Fog toward the edges. `dpr={[1, 2]}`. If `prefers-reduced-motion`: no pulsing, no particles, instant camera moves.

---

## 9. Interaction

| Action                            | Result                                                                     |
| --------------------------------- | -------------------------------------------------------------------------- |
| Hover a pod, board, gate, or rack | Outline brightens; cursor = pointer; tooltip with name + state             |
| Click a pod                       | Camera flies to the pod's front (~0.8s ease). Then the Agent drawer opens. |
| Click the plan wall               | Camera frames the wall; Plan drawer opens                                  |
| Click the PR board or the gate    | PR drawer opens                                                            |
| Click a rack                      | Environment drawer opens for that environment                              |
| Esc or the close button           | Drawer closes; camera returns to the default view                          |
| Number keys 1/2/3                 | Jump to John / Bob / Alice                                                 |
| `D`                               | Toggle the debug panel                                                     |

---

## 10. HUD

### Layout

```
┌────────────────────────────── TopBar ──────────────────────────────┐
│ TeamPanel (left, 280px)        3D scene                  Drawer    │
│                                                    (right, 520px,  │
│                                                     when open)     │
│ ActivityFeed (bottom-left, 360px × 220px)                          │
└────────────────────────────────────────────────────────────────────┘
```

### Components

| Component             | Content                                                                                                                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TopBar**            | "JSM HQ" wordmark · project name + repo · mode chip "Sandbox · 3 running" · current phase chip · speed toggle 1x/2x/4x · debug button                                                                                                                |
| **TeamPanel**         | One card per agent: color dot, name, role, model, state badge, current task, time in state. A card with `needs-input` pulses red and shows its note. Click = same as clicking the pod.                                                               |
| **ActivityFeed**      | Newest first, icon per event type, relative time ("12s ago"). New items slide in.                                                                                                                                                                    |
| **AgentDrawer**       | Header: name, role, model, mode, state. Tabs: **Terminal** (xterm.js, full height, mock output, accepts typing), **Task** (current task: ID, title, needs, status, PR link), **Environment** (URL, status). Lead: Task tab shows "Planning Phase 4". |
| **PlanDrawer**        | All phases as a vertical list with status. The current phase expanded as a kanban board of its tasks.                                                                                                                                                |
| **PrDrawer**          | Open PRs, then merged. Each row: number, title, author, review chip, comments, mergeable. "Open on GitHub" button (disabled in the mock).                                                                                                            |
| **EnvironmentDrawer** | Name, URL, status, last deploy, which agent uses it                                                                                                                                                                                                  |
| **DebugPanel**        | Raw `OfficeSnapshot` as collapsible JSON + the last 20 `OfficeEvent`s                                                                                                                                                                                |

### Terminal input (mock)

Typing into an agent's terminal echoes the text. On Enter, the mock replies after 1s with a canned line, e.g. John: "Got it. Assigning P3-T04 to Bob." Alice in `needs-input`: Enter clears her `needs-input` state.

---

## 11. Design tokens

```ts
// src/theme/tokens.ts
export const colors = {
  bg: "#070B14",
  surface: "#0E1526",
  surfaceRaised: "#141D33",
  border: "#1F2A44",
  text: "#E6EDF7",
  textMuted: "#8A97B1",
  floorGrid: "#13203A",
  working: "#22D3EE",
  needsInput: "#F43F5E",
  inReview: "#F59E0B",
  passed: "#22C55E",
  idle: "#475569",
  lead: "#8B5CF6",
  agent: { john: "#8B5CF6", bob: "#38BDF8", alice: "#F472B6" },
} as const;

export const font = {
  ui: "Inter, system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
};
```

| Rule         | Detail                                                                                  |
| ------------ | --------------------------------------------------------------------------------------- |
| HUD style    | Dark glass panels: `surface` at 80% opacity, `backdrop-blur`, 1px `border`, 12px radius |
| Text         | 13–14px UI text, 12px mono in terminals                                                 |
| State colors | Same colors in the 3D scene and the HUD                                                 |
| Agent colors | Used for owner dots, avatars, and PR author chips                                       |

---

## 12. Code rules

| Rule           | Detail                                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data access    | Components read only from the zustand store. Only the store talks to `OfficeDataSource`.                                                                                  |
| Mock isolation | Everything fake lives in `src/data/mock/`. Swapping in a real source must need no UI changes.                                                                             |
| Config-driven  | Hide the review gate and PR token gate step if `reviewGate.enabled` is false. Hide the server room and pipes if `environments.enabled` is false. Labels come from config. |
| Components     | One scene object per file. Keep files under ~200 lines.                                                                                                                   |
| Types          | No `any`. Import from `src/data/types.ts`.                                                                                                                                |
| Performance    | 60fps on a recent laptop. Reuse geometries and materials. Pod screens update at most 4 times per second.                                                                  |

---

## 13. Build order

1. Vite + Tailwind + R3F setup; floor, lights, camera, bloom
2. Types, data source interface, fixtures, mock source, store
3. Pods with state colors, labels, pod screens
4. Plan wall, PR board, review gate + rabbit, server room, pipes
5. Timeline simulation, PR token movement
6. HUD: TopBar, TeamPanel, ActivityFeed
7. Drawers, xterm terminal, camera fly-to
8. Debug panel, keyboard shortcuts, reduced motion, polish

---

## 14. Done when

- [ ] The office renders with 3 pods, plan wall, PR board, review gate with rabbit, server room, pipes
- [ ] The timeline runs on loop: states change, cards move, a PR token travels pod → gate → main, the rabbit hops on pass
- [ ] Clicking each object opens the right drawer, with a camera fly-to
- [ ] The agent terminal shows streaming fake output and accepts typing
- [ ] Setting `reviewGate.enabled` or `environments.enabled` to false hides those parts cleanly
- [ ] The debug panel shows the raw snapshot and recent events
- [ ] Runs at 60fps; no console errors; no network requests
