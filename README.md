# JSM HQ

A pixel-art office where you run a team of AI coding agents. Every agent works at its own desk (its own Docker Sandbox), and the office shows the team's work as it happens: the plan, tasks, pull requests, reviews and deploys.

> **This is the UI preview.** Everything runs in your browser with mock data. Nothing connects to Docker, GitHub or any server yet.

## Requirements

- [Node.js](https://nodejs.org) 20 or newer
- [pnpm](https://pnpm.io) 10 (or run `corepack enable` to get it)

## Run it

```bash
pnpm install
pnpm dev
```

Then open the URL it prints, usually **http://localhost:5173**.

## Things to try

| Do this                         | What happens                                       |
| ------------------------------- | -------------------------------------------------- |
| Click an agent or their desk    | The camera moves to them and their terminal opens |
| Type in a terminal, press Enter | The agent replies. A red "Needs input" agent continues |
| Click the plan wall             | Boards open. Assign a task to anyone               |
| Click the review gate or PR board | Open and merged pull requests                    |
| Click a server rack             | That environment's details                         |
| **Settings → Team**             | Add or remove agents. The office grows to fit      |
| **Settings → Workflow**         | Switch review/deploy tools, or turn them off       |
| **Settings → Sandbox**          | Network policy, allowed domains, proxy, secrets   |
| **2x / 4x** in the top bar      | Speed up the simulation                            |
| **Debug → Load preset**         | Switch to a 7-agent team or a 2-agent team         |

**Keyboard:** `1`–`9` jump to an agent · `Esc` closes panels · `D` toggles debug · `+` / `-` zoom. Drag to pan, scroll to zoom.

## Scripts

| Command          | Does                              |
| ---------------- | --------------------------------- |
| `pnpm dev`       | Start the app with hot reload     |
| `pnpm build`     | Type-check and build to `dist/`   |
| `pnpm preview`   | Serve the production build        |
| `pnpm typecheck` | Type-check only                   |

## Project layout

```
src/
  data/      Domain types, the data source interface, and the mock (src/data/mock)
  store/     Zustand stores; the only code that talks to the data source
  office/    The PixiJS pixel office: layout generator, sprites, agents, belt
  ui/        Top bar, team panel, activity feed, drawers, settings
docs/        Product idea and build spec
```

The real backend will replace the mock by swapping one line in `src/store/office.ts`.
