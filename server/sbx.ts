// Real sandbox settings through the sbx CLI. HQ reads back what sbx has (rules,
// keys, proxy) and syncs each agent's allowed/blocked domains. It only ever
// removes rules it added itself (tracked in ~/.jsmhq/<project>/sbx-owned.json).

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BasePolicy, SbxAgentState, SbxRule, SbxState } from "../src/data/types";
import type { Hub } from "./hub";
import { parseCliJson, sandboxList } from "./lib/json";
import { run } from "./lib/exec";
import { log } from "./lib/log";
import { projectHome, sessionName } from "./paths";

interface RawRule {
  id: string;
  applies_to: string;
  resource_type: string;
  decision: "allow" | "deny";
  resources: string[];
  layer: string; // local | org | …
  origin?: string;
  status?: string;
  provenance?: { created_via?: string };
}

const key = (decision: string, resource: string) => `${decision} ${resource}`;

/**
 * The resource an approval is for, as an allow rule: "mcp.notion.com:443". The port is kept so Allow
 * opens exactly what was blocked. HTTP-style titles ("GET host:443/path") keep only host:port.
 */
export function approvalHost(title: string): string {
  const m = title.trim().match(/^(?:[A-Z]+\s+)?(?:[a-z]+:\/\/)?([^/\s?#]+)/);
  return (m?.[1] ?? title.trim()).toLowerCase();
}

export class Sbx {
  state: SbxState;
  private ownedFile: string;
  private owned: Record<string, string[]>; // sandbox name → "allow foo.com" entries HQ added

  constructor(private hub: Hub) {
    this.ownedFile = join(projectHome(hub.slug), "sbx-owned.json");
    this.owned = (existsSync(this.ownedFile) && parseCliJson<Record<string, string[]>>(readFileSync(this.ownedFile, "utf8"))) || {};
    this.state = { basePolicy: "unknown", proxy: null, globalKeys: [], agents: {}, checkedAt: new Date().toISOString() };
  }

  private saveOwned() {
    writeFileSync(this.ownedFile, JSON.stringify(this.owned, null, 2));
  }

  private name(agentId: string) {
    return sessionName(this.hub.slug, agentId);
  }

  envFile(agentId: string) {
    return join(projectHome(this.hub.slug), `${agentId}.env`);
  }

  private publish() {
    this.state.checkedAt = new Date().toISOString();
    this.hub.snap.sbx = this.state;
    this.hub.emit({ type: "sbx.updated", sbx: structuredClone(this.state) });
  }

  // ------------------------------------------------------------ read back

  private async rules(): Promise<RawRule[]> {
    const r = await run("sbx", ["policy", "ls", "--json", "--type", "network"], { timeoutMs: 15_000 });
    if (!r.ok) return [];
    try {
      return (parseCliJson<{ rules?: RawRule[] }>(r.stdout)?.rules ?? []).filter((x) => x.resource_type === "network" && x.status !== "inactive");
    } catch {
      return [];
    }
  }

  private async basePolicy(): Promise<BasePolicy> {
    const allowed = async (target: string) => /^Allowed/m.test((await run("sbx", ["policy", "check", "network", target], { timeoutMs: 10_000 })).stdout);
    // A made-up host is only allowed under allow-all; a registry is allowed under balanced too.
    if (await allowed("hq-probe.invalid")) return "allow-all";
    if (await allowed("registry.npmjs.org")) return "balanced";
    return "deny-all";
  }

  /** Re-reads everything from sbx and publishes it. */
  async refresh() {
    if (!this.hub.snap.setup.sandboxReady) {
      this.state.agents = Object.fromEntries(this.hub.snap.config.team.map((a) => [a.id, this.emptyAgent(a.id)]));
      return this.publish();
    }
    const [rules, keysOut, proxyOut, base] = await Promise.all([
      this.rules(),
      run("sbx", ["secret", "ls", "--json"], { timeoutMs: 15_000 }),
      run("sbx", ["settings", "get", "proxy.sandbox"], { timeoutMs: 10_000 }),
      this.basePolicy(),
    ]);
    let secrets: { scope: string; type: string; name: string }[] = [];
    try {
      secrets = parseCliJson<{ secrets?: typeof secrets }>(keysOut.stdout)?.secrets ?? [];
    } catch {
      /* sbx down */
    }
    this.state.basePolicy = base;
    this.state.proxy = proxyOut.stdout.trim() || null;
    this.state.globalKeys = secrets.filter((s) => s.type === "service" && s.scope === "global").map((s) => s.name);
    const prevErrors = this.state.agents;
    this.state.agents = {};
    for (const a of this.hub.snap.config.team) {
      const name = this.name(a.id);
      const mine = new Set(this.owned[name] ?? []);
      const sandboxRules: SbxRule[] = rules
        .filter((r) => r.applies_to === `sandbox:${name}`)
        .map((r) => ({
          id: r.id,
          decision: r.decision,
          resources: r.resources,
          source: r.layer === "org" ? "org" : r.origin === "kit" || ["default", "provisioned"].includes(r.provenance?.created_via ?? "") ? "kit" : r.resources.every((x) => mine.has(key(r.decision, x))) ? "hq" : "cli",
        }));
      this.state.agents[a.id] = {
        rules: sandboxRules,
        // sbx reports a sandbox scope as the bare sandbox name.
        keys: secrets.filter((s) => s.type === "service" && (s.scope === name || s.scope === `sandbox:${name}`)).map((s) => s.name),
        envFile: { path: this.envFile(a.id), exists: existsSync(this.envFile(a.id)) },
        syncError: prevErrors[a.id]?.syncError ?? null,
        approvals: prevErrors[a.id]?.approvals ?? [],
      };
    }
    this.publish();
  }

  private emptyAgent(agentId: string): SbxAgentState {
    return { rules: [], keys: [], envFile: { path: this.envFile(agentId), exists: existsSync(this.envFile(agentId)) }, syncError: null, approvals: [] };
  }

  // ------------------------------------------------------------ approvals

  private seenApprovals = new Set<string>();
  private approvalTimer: NodeJS.Timeout | null = null;

  /** sbx's queue of blocked requests. It has no JSON output, so the table is read by its header's columns. */
  private async readApprovals(): Promise<{ id: string; sandbox: string; title: string; detail: string }[] | null> {
    const r = await run("sbx", ["policy", "approval", "ls"], { timeoutMs: 10_000 });
    if (!r.ok) return null;
    const lines = r.stdout.split("\n").filter((l) => l.trim());
    const head = lines.findIndex((l) => /^APPROVAL\s+SANDBOX\s+TITLE\s+DETAIL/.test(l));
    if (head === -1) return lines.length ? null : [];
    const at = ["APPROVAL", "SANDBOX", "TITLE", "DETAIL", "OPTIONS"].map((c) => lines[head].indexOf(c));
    const cell = (l: string, i: number) => l.slice(at[i], at[i + 1] > 0 ? at[i + 1] : undefined).trim();
    return lines
      .slice(head + 1)
      .map((l) => ({ id: cell(l, 0), sandbox: cell(l, 1), title: cell(l, 2), detail: cell(l, 3) }))
      .filter((a) => /^network:\S+$/.test(a.id));
  }

  /** Re-reads the approval queue and shows each HQ agent's blocked requests (new ones once in the activity feed). */
  async refreshApprovals() {
    if (!this.hub.snap.setup.sandboxReady) return;
    const all = await this.readApprovals();
    if (!all) return;
    let changed = false;
    const fresh: { agentId: string; host: string }[] = [];
    for (const a of this.hub.snap.config.team) {
      const name = this.name(a.id);
      const list = all
        .filter((x) => x.sandbox === name)
        .map((x) => ({
          id: x.id,
          host: approvalHost(x.title),
          detail: x.detail.replace(/^Protocol: \S+ Resource type: \S+ /, ""),
          hostWide: approvalHost(x.title) === x.title.trim().toLowerCase(),
        }));
      const st = (this.state.agents[a.id] ??= this.emptyAgent(a.id));
      if (JSON.stringify(st.approvals) !== JSON.stringify(list)) {
        st.approvals = list;
        changed = true;
      }
      for (const x of list) if (!this.seenApprovals.has(x.id)) (this.seenApprovals.add(x.id), fresh.push({ agentId: a.id, host: x.host }));
    }
    if (changed) this.publish();
    const byAgent = new Map<string, string[]>();
    for (const f of fresh) byAgent.set(f.agentId, [...(byAgent.get(f.agentId) ?? []), f.host]);
    for (const [id, hosts] of byAgent)
      this.hub.activity("agent.needs-input", id, `${this.hub.name(id)}'s sandbox blocked ${hosts.slice(0, 3).join(", ")}${hosts.length > 3 ? ` and ${hosts.length - 3} more` : ""}. Allow or dismiss in the agent's drawer.`);
  }

  startApprovalPolling(ms = 5000) {
    if (this.approvalTimer) return;
    const tick = () => void this.refreshApprovals().catch((e) => log.warn("approvals:", e));
    tick();
    this.approvalTimer = setInterval(tick, ms);
  }

  stopApprovalPolling() {
    if (this.approvalTimer) clearInterval(this.approvalTimer);
    this.approvalTimer = null;
  }

  private answering = new Set<string>(); // agents with an answer in flight

  /**
   * Answers blocked requests. Allow adds an HQ-owned allow rule for exactly that host:port (shown and
   * removable in Settings → Sandbox) and clears every queued request for it; Dismiss clears only the one
   * (or all with "all"). One answer per agent at a time; a second click meanwhile is ignored.
   */
  async answerApproval(agentId: string, approvalId: string | "all", decision: "allow" | "dismiss") {
    if (this.answering.has(agentId)) return;
    this.answering.add(agentId);
    try {
      await this.answer(agentId, approvalId, decision);
    } finally {
      this.answering.delete(agentId);
    }
  }

  private async answer(agentId: string, approvalId: string | "all", decision: "allow" | "dismiss") {
    const list = [...(this.state.agents[agentId]?.approvals ?? [])];
    const target = approvalId === "all" ? null : list.find((a) => a.id === approvalId);
    if (approvalId !== "all" && !target) return;
    const respond = async (id: string, option: "allow" | "dismiss") => (await run("sbx", ["policy", "approval", "respond", id, "--option", option], { timeoutMs: 10_000 })).ok;

    if (decision === "allow" && target) {
      const who = this.hub.name(agentId);
      // Blocked by an organization policy (a local rule wouldn't apply), or narrower than host:port
      // (a rule would allow more than was asked): answer sbx's own approval, which keeps its scope.
      if (/required by policy|organi[sz]ation/i.test(target.detail) || target.hostWide === false) {
        if (await respond(target.id, "allow")) this.hub.activity("config", agentId, `You approved ${target.host} for ${who}'s sandbox`);
        else this.hub.activity("config", agentId, `Couldn't approve ${target.host}: sbx refused it.`);
        return this.refreshApprovals();
      }
      const agent = this.hub.cfg(agentId);
      if (!agent) return;
      const added = !agent.sandbox.allow.includes(target.host);
      if (added) {
        agent.sandbox.allow = [...agent.sandbox.allow, target.host];
        this.hub.configChanged();
      }
      await this.syncRules(agentId);
      const err = this.state.agents[agentId]?.syncError;
      if (err?.includes(target.host)) {
        if (added) {
          agent.sandbox.allow = agent.sandbox.allow.filter((h) => h !== target.host);
          this.hub.configChanged();
          await this.syncRules(agentId);
        }
        this.hub.activity("config", agentId, `Couldn't allow ${target.host}: ${err.slice(0, 160)}`);
        return;
      }
      for (const a of list.filter((x) => x.host === target.host)) await respond(a.id, "dismiss");
      this.hub.activity("config", agentId, `You allowed ${target.host} for ${who}'s sandbox`);
    } else {
      for (const a of approvalId === "all" ? list : [target!]) await respond(a.id, "dismiss");
    }
    await this.refreshApprovals();
  }

  // ------------------------------------------------------------ apply

  /** True if sbx knows a sandbox with this name. */
  async exists(agentId: string): Promise<boolean> {
    const r = await run("sbx", ["ls", "--json"], { timeoutMs: 10_000 });
    try {
      return (sandboxList(r.stdout) ?? []).some((s) => s.name === this.name(agentId));
    } catch {
      return false;
    }
  }

  /**
   * Makes the sandbox's allow/deny rules match the agent's lists. Adds what's
   * missing; removes only rules HQ added earlier. Needs the sandbox to exist.
   */
  async syncRules(agentId: string): Promise<void> {
    const agent = this.hub.cfg(agentId);
    if (!agent || agent.mode !== "sandbox" || !(await this.exists(agentId))) return;
    const name = this.name(agentId);
    const want = new Set([...agent.sandbox.allow.map((r) => key("allow", r)), ...agent.sandbox.deny.map((r) => key("deny", r))]);
    const owned = new Set(this.owned[name] ?? []);
    const rules = (await this.rules()).filter((r) => r.applies_to === `sandbox:${name}`);
    const have = new Set(rules.flatMap((r) => r.resources.map((x) => key(r.decision, x))));
    const errors: string[] = [];

    for (const entry of want) {
      if (have.has(entry)) continue;
      const [decision, resource] = entry.split(" ");
      const r = await run("sbx", ["policy", decision, "network", "--sandbox", name, resource], { timeoutMs: 15_000 });
      if (r.ok) owned.add(entry);
      else errors.push(`${decision} ${resource}: ${r.stderr.trim().split("\n")[0]}`);
    }
    for (const entry of [...owned]) {
      if (want.has(entry)) continue;
      const [decision, resource] = entry.split(" ");
      const rule = rules.find((r) => r.decision === decision && r.resources.includes(resource));
      const r = rule
        ? await run("sbx", ["policy", "rm", "network", "--sandbox", name, "--id", rule.id, "--force"], { timeoutMs: 15_000 })
        : { ok: true, stderr: "" };
      if (r.ok) owned.delete(entry);
      else errors.push(`remove ${resource}: ${r.stderr.trim().split("\n")[0]}`);
    }
    this.owned[name] = [...owned];
    this.saveOwned();
    if (errors.length) log.warn(`sbx rules for ${name}:`, errors.join("; "));
    await this.refresh();
    if (this.state.agents[agentId]) {
      this.state.agents[agentId].syncError = errors.length ? errors.join("; ") : null;
      this.publish();
    }
  }

  /** Stores a service key (value via stdin, never kept). agentId null = every sandbox. */
  async setKey(agentId: string | null, service: string, value: string) {
    const args = ["secret", "set", service, ...(agentId ? ["--sandbox", this.name(agentId)] : []), "--force"];
    const r = await run("sbx", args, { timeoutMs: 20_000, input: value.trim() + "\n" });
    if (!r.ok) throw new Error(r.stderr.trim().split("\n")[0] || "sbx secret set failed");
    await this.refresh();
  }

  async removeKey(agentId: string | null, service: string) {
    const r = await run("sbx", ["secret", "rm", service, ...(agentId ? ["--sandbox", this.name(agentId)] : []), "--force"], { timeoutMs: 20_000 });
    if (!r.ok) throw new Error(r.stderr.trim().split("\n")[0] || "sbx secret rm failed");
    await this.refresh();
  }

  async setProxy(url: string | null) {
    const r = url
      ? await run("sbx", ["settings", "set", "proxy.sandbox", url], { timeoutMs: 15_000 })
      : await run("sbx", ["settings", "unset", "proxy.sandbox"], { timeoutMs: 15_000 });
    if (!r.ok) throw new Error(r.stderr.trim().split("\n")[0] || "sbx settings failed");
    await this.refresh();
  }

  /** Creates the agent's env file (0600) if missing. Returns its path. Never reads values. */
  ensureEnvFile(agentId: string): string {
    const file = this.envFile(agentId);
    if (!existsSync(file)) {
      writeFileSync(
        file,
        `# App variables for ${this.hub.name(agentId)} (${this.hub.snap.config.project.name}).\n` +
          "# One KEY=value per line. These values ENTER the agent's VM — use test/dev credentials.\n" +
          "# Restart the agent after editing. JSM HQ never reads or commits this file.\n",
        { mode: 0o600 },
      );
    }
    chmodSync(file, 0o600);
    return file;
  }
}
