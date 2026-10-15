import { agentPalette } from "../../theme/tokens";
import type { OfficeDataSource, OfficeEvent, SimSpeed } from "../source";
import type { AgentConfig, AgentPatch, Board, NewAgentInput, ProjectConfig, SandboxSettings, WorkflowPatch } from "../types";
import { defaultPresetId, presets, type Preset } from "./presets";
import { Simulation } from "./simulation";
import * as T from "./terminalScripts";
import { mockSbx, mockSession, mockSetup, World } from "./world";

const TICK_MS = 50;
const TERM_MS = 30;


export function createMockSource(): OfficeDataSource {
  let presetId = defaultPresetId;
  let world = new World(findPreset(presetId));
  let sim = new Simulation(world);
  let listener: ((e: OfficeEvent) => void) | null = null;
  let timers: number[] = [];
  let last = 0;
  let inputBuf = new Map<string, string>();

  function findPreset(id: string): Preset {
    return presets.find((p) => p.id === id) ?? presets[0];
  }

  /** Fresh world for the current preset (keeps the speed). */
  function reset() {
    const speed = world.speed;
    world.clearTimers();
    world.setEmitter(null);
    world = new World(findPreset(presetId));
    world.speed = speed;
    sim = new Simulation(world);
    inputBuf = new Map();
  }

  function boot() {
    world.setEmitter((e) => listener?.(e));
    listener?.({ type: "snapshot", snapshot: structuredClone(world.snap) });
    sim.start();
  }

  function loop() {
    const t = performance.now();
    const dt = Math.min(0.25, (t - last) / 1000) * world.speed;
    last = t;
    world.advance(dt);
    sim.tick(dt);
  }

  /** Rebuilds the mock "sbx" state from config, keeping any keys set in the UI. */
  function syncSbx() {
    const old = world.snap.sbx;
    const next = mockSbx(world.snap.config.team, world.snap.config.project.name);
    next.globalKeys = old.globalKeys;
    next.proxy = old.proxy;
    for (const id of Object.keys(next.agents)) if (old.agents[id]) next.agents[id].keys = old.agents[id].keys;
    world.snap.sbx = next;
    world.emit({ type: "sbx.updated", sbx: structuredClone(next) });
  }

  function hostCmd(agentId: string, text: string) {
    world.write(agentId, [{ text: `\x1b[38;2;102;114;159mhq ▸ ${text}\x1b[0m` }]);
  }

  const source: OfficeDataSource = {
    connect(onEvent, onStatus) {
      listener = onEvent;
      onStatus?.("open");
      last = performance.now();
      reset();
      boot();
      timers = [
        window.setInterval(loop, TICK_MS),
        window.setInterval(() => world.flushTerminals(Math.max(1, Math.round(world.speed * 1.3))), TERM_MS),
      ];
      return () => {
        timers.forEach((id) => window.clearInterval(id));
        timers = [];
        world.clearTimers();
        world.setEmitter(null);
        listener = null;
      };
    },

    sendTerminalInput(agentId, data) {
      // Echo printable input; act on Enter.
      let buf = inputBuf.get(agentId) ?? "";
      for (const ch of data) {
        if (ch === "\r") {
          const text = buf.trim();
          buf = "";
          listener?.({ type: "terminal.output", agentId, data: "\r\n" });
          if (!text) continue;
          const st = world.status(agentId);
          if (st?.state === "needs-input") {
            world.after(0.6, () => sim.answer(agentId, "you"));
          } else {
            world.after(1, () => world.write(agentId, T.cannedReply(!!world.cfg(agentId)?.isLead, text.length)));
          }
        } else if (ch === "\x7f") {
          if (buf.length) {
            buf = buf.slice(0, -1);
            listener?.({ type: "terminal.output", agentId, data: "\b \b" });
          }
        } else if (ch >= " ") {
          buf += ch;
          listener?.({ type: "terminal.output", agentId, data: ch });
        }
      }
      inputBuf.set(agentId, buf);
    },

    sendMessage(toId, text) {
      if (!world.cfg(toId) || !text.trim()) return;
      world.message("you", toId, text.trim());
      world.after(1.2, () => world.write(toId, T.cannedReply(!!world.cfg(toId)?.isLead, text.length)));
    },

    resizeTerminal() {
      // The mock streams plain lines, so size doesn't matter.
    },

    startAgent(id) {
      const st = world.status(id);
      if (!st || st.session.state === "running") return;
      world.setStatus(id, { session: { ...st.session, state: "running", detail: null } });
      world.activity("session", id, `${world.name(id)}'s session started`);
      if (!world.cfg(id)?.isLead) sim.startWorker(id, 1.5);
    },

    stopAgent(id) {
      const st = world.status(id);
      if (!st) return;
      sim.stopAgent(id);
      world.setStatus(id, { state: "idle", currentTaskId: null, note: "Stopped", session: { ...st.session, state: "stopped", detail: null } });
      world.activity("session", id, `${world.name(id)}'s session stopped`);
    },

    recreateSandbox(id) {
      const st = world.status(id);
      const r = world.cfg(id)?.sandbox.resources;
      if (!st || !r) return;
      world.setStatus(id, { session: { ...st.session, sandbox: { cpus: r.cpus ?? 8, memoryGb: r.memoryGb ?? 8 } } });
      hostCmd(id, `sbx rm hq-…-${id} && sbx run --cpus ${r.cpus ?? "auto"} --memory ${r.memoryGb ?? "auto"}g … (mock)`);
      world.activity("session", id, `Recreated ${world.name(id)}'s sandbox`);
    },

    openWorkspace(id) {
      hostCmd(id, `open ${world.status(id)?.session.workspace ?? "?"} (mock: nothing opens)`);
    },

    recheckSetup() {
      world.snap.setup = mockSetup();
      world.emit({ type: "setup.updated", setup: world.snap.setup });
    },

    runSetupFix() {
      // Everything is installed in the mock.
    },

    assignTask(taskId, agentId) {
      const task = world.task(taskId);
      const agent = world.cfg(agentId);
      if (!task || !agent || agent.isLead || task.status !== "todo") return;
      world.patchTask(taskId, { ownerId: agentId });
      world.activity("task.assigned", null, `You assigned ${taskId} ${task.title} to ${agent.name}`);
      if (!sim.hasJob(agentId) && world.status(agentId)?.state === "idle") {
        world.message(world.lead().id, agentId, `Pull main, start ${taskId}.`);
        world.after(1, () => sim.begin(agentId, taskId), agentId);
      }
    },

    addAgent(input: NewAgentInput) {
      const team = world.snap.config.team;
      const base = T.slug(input.name) || "agent";
      let id = base;
      for (let i = 2; team.some((a) => a.id === id); i++) id = `${base}-${i}`;
      const used = new Set(team.map((a) => a.color));
      const color = agentPalette.find((c) => !used.has(c)) ?? agentPalette[team.length % agentPalette.length];
      const lead = world.lead();
      const agent: AgentConfig = {
        id, name: input.name.trim() || "Agent", role: input.role.trim() || "Developer", isLead: false, cli: input.cli ?? "claude",
        model: input.model ?? "", mode: input.mode, color, skills: ["plan", "review"],
        roleMd: `# ${input.name} — ${input.role}\n\nYou build the tasks assigned to you.`,
        sandbox: structuredClone(lead.sandbox),
        workspacePath: null,
      };
      team.push(agent);
      world.snap.agents.push({
        agentId: id, state: "idle", currentTaskId: null, stateSince: new Date().toISOString(), note: null,
        session: mockSession(world.snap.config.project.name, id),
      });
      world.configChanged();
      world.emit({ type: "agent.updated", agent: { ...world.snap.agents[world.snap.agents.length - 1] } });
      world.syncEnvironments();
      world.activity("config", null, `Added ${agent.name} (${agent.role}) — new sandbox starting`);
      world.write(id, T.banner(agent.name, agent.role, world.snap.config.project.repo, agent.mode));
      hostCmd(id, `sbx run claude · allow host.docker.internal:${world.snap.config.project.hqPort}`);
      syncSbx();
      sim.startWorker(id, 2);
    },

    updateAgent(id, patch: AgentPatch) {
      const agent = world.cfg(id);
      if (!agent) return;
      Object.assign(agent, patch);
      world.configChanged();
    },

    inspectWorkspace(id) {
      const st = world.status(id);
      if (!st) return;
      listener?.({
        type: "workspace.info",
        info: { agentId: id, path: st.session.workspace ?? "", managed: true, exists: true, changedFiles: 1, unpushedCommits: 2, sandboxName: `hq-mock-${id}`, sandboxExists: true },
      });
    },

    removeAgent(id) {
      const agent = world.cfg(id);
      if (!agent || agent.isLead) return;
      sim.stopAgent(id);
      world.snap.config.team = world.snap.config.team.filter((a) => a.id !== id);
      world.snap.agents = world.snap.agents.filter((a) => a.agentId !== id);
      for (const t of world.snap.tasks)
        if (t.ownerId === id && t.status !== "done") world.patchTask(t.id, { ownerId: null, status: t.status === "in-progress" ? "todo" : t.status });
      world.emit({ type: "agent.removed", agentId: id });
      world.configChanged();
      world.syncEnvironments();
      world.activity("config", null, `Removed ${agent.name} — sandbox stopped`);
    },

    updateSandbox(agentId, patch: Partial<SandboxSettings>) {
      const agent = world.cfg(agentId);
      if (!agent) return;
      Object.assign(agent.sandbox, structuredClone(patch));
      world.configChanged();
      if (patch.allow || patch.deny) {
        hostCmd(agentId, `sbx policy allow/deny network --sandbox hq-mock-${agentId} … (mock)`);
        syncSbx();
      }
      world.activity("config", agentId, `Updated ${agent.name}'s sandbox settings`);
    },

    setSecret(agentId, service, value) {
      void value; // A real source pipes this to `sbx secret set`; HQ never keeps it.
      const sbx = world.snap.sbx;
      if (agentId === null) sbx.globalKeys = [...new Set([...sbx.globalKeys, service])];
      else if (sbx.agents[agentId]) sbx.agents[agentId].keys = [...new Set([...sbx.agents[agentId].keys, service])];
      world.emit({ type: "sbx.updated", sbx: structuredClone(sbx) });
      world.activity("config", agentId, `Stored the ${service} key ${agentId ? `for ${world.name(agentId)}` : "for every sandbox"} (mock)`);
    },

    removeSecret(agentId, service) {
      const sbx = world.snap.sbx;
      if (agentId === null) sbx.globalKeys = sbx.globalKeys.filter((k) => k !== service);
      else if (sbx.agents[agentId]) sbx.agents[agentId].keys = sbx.agents[agentId].keys.filter((k) => k !== service);
      world.emit({ type: "sbx.updated", sbx: structuredClone(sbx) });
    },

    setProxy(url) {
      world.snap.sbx.proxy = url;
      world.emit({ type: "sbx.updated", sbx: structuredClone(world.snap.sbx) });
    },

    openEnvFile(agentId) {
      hostCmd(agentId, `open ${world.snap.sbx.agents[agentId]?.envFile.path ?? "?"} (mock: nothing opens)`);
    },

    refreshSbx() {
      syncSbx();
    },

    updateWorkflow(patch: WorkflowPatch) {
      const wf = world.snap.config.workflow;
      Object.assign(wf.review, patch.review);
      Object.assign(wf.merge, patch.merge);
      Object.assign(wf.deploy, patch.deploy);
      world.configChanged();
      world.syncEnvironments();
      sim.workflowChanged();
      world.activity("config", null, "Workflow updated");
    },

    updateProject(patch: Partial<ProjectConfig>) {
      Object.assign(world.snap.config.project, patch);
      world.configChanged();
      world.syncEnvironments();
    },

    createBoard(title) {
      const clean = title.trim();
      if (!clean) return;
      const base = clean.split(/\s+/).map((w) => w[0]).join("").toUpperCase().slice(0, 3) || "B";
      let id = base;
      for (let i = 2; world.snap.boards.some((b) => b.id === id); i++) id = `${base}${i}`;
      const board: Board = { id, title: clean, status: "planned", order: world.snap.boards.length };
      world.snap.boards.push(board);
      world.emit({ type: "board.updated", board: { ...board } });
      world.activity("config", null, `Created board ${clean}`);
    },

    updateBoard(id, patch) {
      const board = world.snap.boards.find((b) => b.id === id);
      if (!board) return;
      Object.assign(board, patch);
      world.emit({ type: "board.updated", board: { ...board } });
    },

    dev: {
      presets: presets.map((p) => ({ id: p.id, label: p.label })),
      loadPreset(id) {
        presetId = id;
        reset();
        boot();
      },
      setSpeed(multiplier: SimSpeed) {
        world.speed = multiplier;
      },
    },
  };

  return source;
}
