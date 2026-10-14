// Real sandbox settings through the sbx CLI. HQ reads back what sbx has (rules,
// keys, proxy) and syncs each agent's allowed/blocked domains. It only ever
// removes rules it added itself (tracked in ~/.jsmhq/<project>/sbx-owned.json).

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BasePolicy, SbxAgentState, SbxRule, SbxState } from "../src/data/types";
import type { Hub } from "./hub";
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

export class Sbx {
  state: SbxState;
  private ownedFile: string;
  private owned: Record<string, string[]>; // sandbox name → "allow foo.com" entries HQ added

  constructor(private hub: Hub) {
    this.ownedFile = join(projectHome(hub.slug), "sbx-owned.json");
    this.owned = existsSync(this.ownedFile) ? (JSON.parse(readFileSync(this.ownedFile, "utf8")) as Record<string, string[]>) : {};
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
      return ((JSON.parse(r.stdout) as { rules?: RawRule[] }).rules ?? []).filter((x) => x.resource_type === "network" && x.status !== "inactive");
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
      secrets = (JSON.parse(keysOut.stdout) as { secrets?: typeof secrets }).secrets ?? [];
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
      };
    }
    this.publish();
  }

  private emptyAgent(agentId: string): SbxAgentState {
    return { rules: [], keys: [], envFile: { path: this.envFile(agentId), exists: existsSync(this.envFile(agentId)) }, syncError: null };
  }

  // ------------------------------------------------------------ apply

  /** True if sbx knows a sandbox with this name. */
  async exists(agentId: string): Promise<boolean> {
    const r = await run("sbx", ["ls", "--json"], { timeoutMs: 10_000 });
    try {
      return ((JSON.parse(r.stdout) as { sandboxes?: { name: string }[] }).sandboxes ?? []).some((s) => s.name === this.name(agentId));
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
