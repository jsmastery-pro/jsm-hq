// Agent sessions: start/stop in tmux, a pty attached to each for the browser
// terminal, and the setup checklist's "Run in terminal" helper.

import { spawn as spawnPty, type IPty } from "node-pty";
import type { SetupCheckId } from "../src/data/types";
import { MCP_CONFIG, writeAgentFiles } from "./agentFiles";
import type { Hub } from "./hub";
import { run, shq } from "./lib/exec";
import { log } from "./lib/log";
import { sessionName } from "./paths";
import { runSetupChecks } from "./setup";
import * as tmux from "./tmux";
import { ensureWorkspace, workspaceFor } from "./workspace";

const TERM_ENV = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>;

export class Sessions {
  private ptys = new Map<string, IPty>();
  private sizes = new Map<string, { cols: number; rows: number }>();
  private fixes = new Map<string, IPty>();
  private policyOk = false;
  /** Called whenever an agent's Claude Code session goes away (stop, restart, crash). */
  onSessionDown: (agentId: string) => void = () => {};
  /** Called when HQ reattaches to a session that was already running (e.g. after an HQ restart). */
  onSessionReattached: (agentId: string) => void = () => {};
  private polling: NodeJS.Timeout | null = null;

  constructor(private hub: Hub, private agentToken: string) {}

  private name(agentId: string) {
    return sessionName(this.hub.slug, agentId);
  }

  // ------------------------------------------------------------ lifecycle

  async start(id: string) {
    const hub = this.hub;
    const agent = hub.cfg(id);
    const st = hub.status(id);
    if (!agent || !st || st.session.state === "running" || st.session.state === "starting") return;
    const setup = hub.snap.setup;
    const fail = (detail: string) => {
      hub.setSession(id, { state: "failed", detail });
      hub.setStatus(id, { state: "idle", note: "Could not start" });
      hub.activity("session", id, `${agent.name} could not start: ${detail.split("\n")[0]}`);
    };
    if (!setup.checks.find((c) => c.id === "tmux" && c.status === "ok")) return fail("tmux is not installed. See the setup checklist.");
    if (agent.mode === "sandbox" && !setup.sandboxReady) return fail("Docker Sandboxes isn't ready on this machine. Finish the setup checklist, or switch this agent to Local mode.");
    if (agent.mode === "local" && !setup.localReady) return fail("Claude Code isn't installed. See the setup checklist.");

    const name = this.name(id);
    this.onSessionDown(id);
    try {
      hub.setSession(id, { state: "starting", detail: "Preparing folder…", workspace: workspaceFor(agent, hub.slug) });
      const dir = await ensureWorkspace(agent, hub.slug, hub.repo);
      writeAgentFiles(dir, agent, hub.snap.config, this.agentToken);
      if (!(await tmux.hasSession(name))) {
        const mcp = shq(`${dir}/${MCP_CONFIG}`);
        // "Opus" / "Sonnet" / "Haiku" → Claude Code's model aliases.
        const model = /^(opus|sonnet|haiku)$/i.test(agent.model) ? agent.model.toLowerCase() : null;
        const claudeArgs = ["--mcp-config", mcp, ...(model ? ["--model", model] : [])];
        let command = ["claude", ...claudeArgs].join(" ");
        if (agent.mode === "sandbox") {
          hub.setSession(id, { detail: "Allowing the sandbox to reach HQ…" });
          await this.ensurePolicy();
          hub.setSession(id, { detail: "Starting sandbox…" });
          // Size only applies when sbx creates the sandbox; an existing one keeps its size.
          const { cpus, memoryGb } = agent.sandbox.resources;
          const size = [cpus ? `--cpus ${cpus}` : "", memoryGb ? `--memory ${Math.round(memoryGb * 1024)}m` : ""];
          command = ["sbx run --name", shq(name), ...size, "claude", shq(dir), "--", ...claudeArgs].filter(Boolean).join(" ");
        }
        await tmux.newSession(name, dir, command);
      }
      this.attach(id);
      hub.setSession(id, { state: "running", detail: null, workspace: dir });
      hub.setStatus(id, { state: "idle", note: agent.mode === "sandbox" ? "Sandbox running" : "Running locally" });
      hub.activity("session", id, `${agent.name} started (${agent.mode === "sandbox" ? "Docker Sandbox" : "Local mode"})`);
      if (agent.mode === "sandbox") setTimeout(() => void this.refreshSandboxSizes(), 4000);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  async stop(id: string) {
    const hub = this.hub;
    const agent = hub.cfg(id);
    if (!agent) return;
    const name = this.name(id);
    this.onSessionDown(id);
    this.ptys.get(id)?.kill();
    this.ptys.delete(id);
    await tmux.killSession(name);
    // Stop (not remove) the VM so it can resume later with its state.
    if (agent.mode === "sandbox") void run("sbx", ["stop", name], { timeoutMs: 30_000 });
    hub.setSession(id, { state: "stopped", detail: null });
    hub.setStatus(id, { state: "idle", currentTaskId: null, note: "Stopped" });
    hub.activity("session", id, `${agent.name} stopped`);
  }

  /** Removes the agent's sandbox and starts a fresh one (applies new CPU/memory). The folder is kept. */
  async recreate(id: string) {
    const agent = this.hub.cfg(id);
    if (!agent || agent.mode !== "sandbox") return;
    const name = this.name(id);
    if (this.hub.status(id)?.session.state === "running") await this.stop(id);
    this.hub.setSession(id, { state: "starting", detail: "Removing the old sandbox…", sandbox: null });
    const rm = await run("sbx", ["rm", "-f", name], { timeoutMs: 60_000 });
    if (!rm.ok && !/not found|no such/i.test(rm.stderr)) {
      this.hub.setSession(id, { state: "failed", detail: `sbx rm failed: ${rm.stderr.trim()}` });
      return;
    }
    this.hub.setSession(id, { state: "stopped", detail: null });
    this.hub.activity("session", id, `Recreating ${agent.name}'s sandbox with new resources`);
    await this.start(id);
  }

  /** Reads each HQ sandbox's real CPU/memory from `sbx ls --json`. */
  async refreshSandboxSizes() {
    const r = await run("sbx", ["ls", "--json"], { timeoutMs: 10_000 });
    if (!r.ok) return;
    let list: { name: string; cpus?: number; memory_mib?: number }[] = [];
    try {
      list = (JSON.parse(r.stdout) as { sandboxes?: typeof list }).sandboxes ?? [];
    } catch {
      return;
    }
    for (const agent of this.hub.snap.config.team) {
      const found = list.find((s) => s.name === this.name(agent.id));
      const size = found?.cpus && found.memory_mib ? { cpus: found.cpus, memoryGb: Math.round((found.memory_mib / 1024) * 10) / 10 } : null;
      const cur = this.hub.status(agent.id)?.session.sandbox;
      if (JSON.stringify(cur ?? null) !== JSON.stringify(size)) this.hub.setSession(agent.id, { sandbox: size });
    }
  }

  /**
   * Lets sandboxes reach HQ's port (checked once per run, added only if missing).
   * The sandbox proxy evaluates host.docker.internal as localhost, so both are allowed.
   */
  private async ensurePolicy() {
    if (this.policyOk) return;
    const port = this.hub.snap.config.project.hqPort;
    for (const target of [`localhost:${port}`, `host.docker.internal:${port}`]) {
      const check = await run("sbx", ["policy", "check", "network", target], { timeoutMs: 10_000 });
      if (/^Allowed/m.test(check.stdout)) continue;
      const add = await run("sbx", ["policy", "allow", "network", target], { timeoutMs: 10_000 });
      if (!add.ok) throw new Error(`Could not allow ${target}: ${add.stderr.trim()}`);
      log.info(`added sandbox network rule: allow ${target}`);
    }
    this.policyOk = true;
  }

  // ------------------------------------------------------------ terminals

  /** One pty per agent, attached to its tmux session; output goes to every browser. */
  private attach(id: string) {
    if (this.ptys.has(id)) return;
    const size = this.sizes.get(id) ?? { cols: 120, rows: 36 };
    const pty = spawnPty("tmux", ["attach-session", "-t", `=${this.name(id)}`], { name: "xterm-256color", cols: size.cols, rows: size.rows, env: TERM_ENV });
    this.ptys.set(id, pty);
    pty.onData((d) => this.hub.terminal(id, d));
    pty.onExit(() => {
      if (this.ptys.get(id) === pty) this.ptys.delete(id);
    });
  }

  /** Types a line into an agent's Claude Code prompt and submits it. */
  async typeInto(agentId: string, text: string): Promise<boolean> {
    const target = `=${this.name(agentId)}:`;
    if (!(await tmux.hasSession(this.name(agentId)))) return false;
    if (!(await run("tmux", ["send-keys", "-t", target, "-l", text], { timeoutMs: 5000 })).ok) return false;
    await new Promise((r) => setTimeout(r, 200));
    return (await run("tmux", ["send-keys", "-t", target, "Enter"], { timeoutMs: 5000 })).ok;
  }

  async pressEnter(agentId: string): Promise<boolean> {
    return (await run("tmux", ["send-keys", "-t", `=${this.name(agentId)}:`, "Enter"], { timeoutMs: 5000 })).ok;
  }

  input(id: string, data: string) {
    if (id.startsWith("setup:")) return this.fixes.get(id)?.write(data);
    this.ptys.get(id)?.write(data);
  }

  resize(id: string, cols: number, rows: number) {
    const c = Math.max(20, Math.min(400, Math.floor(cols)));
    const r = Math.max(5, Math.min(200, Math.floor(rows)));
    const same = this.sizes.get(id)?.cols === c && this.sizes.get(id)?.rows === r;
    this.sizes.set(id, { cols: c, rows: r });
    const pty = id.startsWith("setup:") ? this.fixes.get(id) : this.ptys.get(id);
    if (!pty) return;
    // A same-size resize doesn't redraw; nudge it so a newly opened terminal gets a full screen.
    if (same) {
      pty.resize(c, Math.max(5, r - 1));
      setTimeout(() => pty.resize(c, r), 60);
    } else pty.resize(c, r);
  }

  async openWorkspace(id: string) {
    const st = this.hub.status(id);
    const agent = this.hub.cfg(id);
    const dir = st?.session.workspace ?? (agent ? workspaceFor(agent, this.hub.slug) : null);
    if (!dir) return;
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    await run(opener, [dir], { timeoutMs: 5000 });
  }

  // ------------------------------------------------------------ health

  /** Keeps session state honest: picks up sessions from before a restart, notices crashes. */
  startPolling() {
    const tick = async () => {
      if (this.hub.snap.setup.checks.find((c) => c.id === "tmux")?.status !== "ok") return;
      for (const agent of this.hub.snap.config.team) {
        const st = this.hub.status(agent.id);
        if (!st || st.session.state === "starting") continue;
        const name = this.name(agent.id);
        const alive = await tmux.hasSession(name);
        if (alive) {
          const pane = await tmux.paneInfo(name);
          if (pane?.dead) {
            const detail = (await tmux.tailText(name)) || `Exited with code ${pane.exitStatus}`;
            await tmux.killSession(name);
            this.ptys.delete(agent.id);
            this.onSessionDown(agent.id);
            this.hub.setSession(agent.id, { state: "failed", detail });
            this.hub.setStatus(agent.id, { state: "idle", note: "Session ended" });
            this.hub.activity("session", agent.id, `${agent.name}'s session ended`);
            continue;
          }
          this.attach(agent.id);
          if (st.session.state !== "running") {
            this.hub.setSession(agent.id, { state: "running", detail: null, workspace: workspaceFor(agent, this.hub.slug) });
            this.hub.setStatus(agent.id, { note: "Reattached" });
            this.onSessionReattached(agent.id);
          }
        } else if (st.session.state === "running") {
          this.ptys.delete(agent.id);
          this.onSessionDown(agent.id);
          this.hub.setSession(agent.id, { state: "stopped", detail: null });
          this.hub.setStatus(agent.id, { state: "idle", note: "Stopped" });
        }
      }
    };
    void tick();
    let n = 0;
    this.polling = setInterval(() => {
      void tick().catch((e) => log.warn("poll:", e));
      // Sandbox sizes change rarely; check every ~30s (and right after a start).
      if (n++ % 10 === 0 && this.hub.snap.setup.sandboxReady) void this.refreshSandboxSizes();
    }, 3000);
  }

  // ------------------------------------------------------------ setup helper

  async recheckSetup() {
    this.hub.setSetup(await runSetupChecks(this.hub.repo));
  }

  /** Runs a check's fix command in a visible terminal. Only commands HQ itself suggested. */
  runFix(checkId: SetupCheckId) {
    const check = this.hub.snap.setup.checks.find((c) => c.id === checkId);
    if (!check?.fix?.runnable || !check.fix.command) return;
    const id = `setup:${checkId}`;
    if (this.fixes.has(id)) return;
    const shell = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/sh";
    const args = process.platform === "win32" ? ["-NoProfile", "-Command", check.fix.command] : ["-lc", check.fix.command];
    const size = this.sizes.get(id) ?? { cols: 100, rows: 16 };
    const pty = spawnPty(shell, args, { name: "xterm-256color", cols: size.cols, rows: size.rows, cwd: this.hub.repo.root, env: TERM_ENV });
    this.fixes.set(id, pty);
    this.hub.terminal(id, `\x1b[2m$ ${check.fix.command}\x1b[0m\r\n`);
    pty.onData((d) => this.hub.terminal(id, d));
    pty.onExit(({ exitCode }) => {
      this.fixes.delete(id);
      this.hub.terminal(id, `\r\n\x1b[${exitCode === 0 ? "32m✓ Done" : `31m✗ Exited with code ${exitCode}`}\x1b[0m\r\n`);
      void this.recheckSetup();
    });
  }

  shutdown() {
    if (this.polling) clearInterval(this.polling);
    // Detach only: tmux keeps the agents running.
    for (const p of this.ptys.values()) p.kill();
    for (const p of this.fixes.values()) p.kill();
  }
}
