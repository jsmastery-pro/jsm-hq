import { useState } from "react";
import type { PolicyLevel } from "../../data/types";
import { officeActions, useOffice } from "../../store/office";
import { Dot, Field, SectionTitle } from "../kit";
import { ChipList, CommitInput, isDomain } from "./controls";
import { ResourcesSection } from "./ResourcesSection";

const LEVELS: { id: PolicyLevel; label: string; detail: string }[] = [
  { id: "open", label: "Open", detail: "All outbound traffic allowed." },
  { id: "balanced", label: "Balanced", detail: "Blocked by default; common dev sites allowed." },
  { id: "locked", label: "Locked Down", detail: "Everything blocked unless you allow it." },
];

export function SandboxSettingsTab({ initialAgentId }: { initialAgentId?: string }) {
  const snap = useOffice((s) => s.snap);
  const [agentId, setAgentId] = useState(initialAgentId ?? snap?.config.team[0]?.id ?? "");
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  if (!snap) return null;
  const agent = snap.config.team.find((a) => a.id === agentId) ?? snap.config.team[0];
  if (!agent) return null;
  const sb = agent.sandbox;
  const update = (patch: Parameters<typeof officeActions.updateSandbox>[1]) => officeActions.updateSandbox(agent.id, patch);
  const port = snap.config.project.hqPort;

  const copyToAll = () => {
    for (const a of snap.config.team) if (a.id !== agent.id) officeActions.updateSandbox(a.id, { policy: sb.policy, allow: [...sb.allow], deny: [...sb.deny], proxy: sb.proxy });
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        {snap.config.team.map((a) => (
          <button key={a.id} className="btn flex items-center gap-1.5 text-[14px]" aria-pressed={a.id === agent.id} onClick={() => setAgentId(a.id)}>
            <Dot color={a.color} size={8} /> {a.name}
          </button>
        ))}
        <button className="btn ml-auto text-[13px]" onClick={copyToAll} title="Copies policy, domains and proxy (not secrets)">
          Copy network settings to all
        </button>
      </div>

      {agent.mode === "local" && (
        <p className="border-[3px] border-orange bg-[#fff1d6] px-3 py-2 text-[14px]">
          {agent.name} runs in Local mode, so these settings apply only once it is switched back to Sandbox.
        </p>
      )}

      <ResourcesSection agent={agent} status={snap.agents.find((a) => a.agentId === agent.id)} team={snap.config.team} machine={snap.setup.machine} />

      <section className="border-[3px] border-ink bg-white p-3">
        <SectionTitle>Network policy</SectionTitle>
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Network policy">
          {LEVELS.map((l) => (
            <button key={l.id} className="btn whitespace-normal px-2.5 py-1.5 text-left" role="radio" aria-checked={sb.policy === l.id} aria-pressed={sb.policy === l.id} onClick={() => update({ policy: l.id })}>
              <div>{l.label}</div>
              <div className="text-[12px] font-normal text-muted">{l.detail}</div>
            </button>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-4">
          <Field label="Allowed domains">
            <ChipList items={sb.allow} onChange={(allow) => update({ allow })} placeholder="registry.npmjs.org" validate={isDomain} />
          </Field>
          <Field label="Blocked domains">
            <ChipList items={sb.deny} onChange={(deny) => update({ deny })} placeholder="*.googleapis.com" validate={isDomain} />
          </Field>
        </div>
        <p className="mt-3 text-[12px] text-muted">
          HQ always allows <span className="font-term text-[15px]">localhost:{port}</span> and <span className="font-term text-[15px]">host.docker.internal:{port}</span> so hooks and the Team MCP can reach it. Every request needs HQ's per-start token.
        </p>
      </section>

      <section className="border-[3px] border-ink bg-white p-3">
        <SectionTitle>Upstream proxy</SectionTitle>
        <Field label="Proxy URL" hint="Optional. The sandbox proxy forwards allowed traffic through this.">
          <CommitInput className="field font-term text-[17px]" value={sb.proxy ?? ""} placeholder="http://proxy.internal:3128" onCommit={(v) => update({ proxy: v.trim() || null })} />
        </Field>
      </section>

      <section className="border-[3px] border-ink bg-white p-3">
        <SectionTitle>Secrets</SectionTitle>
        <p className="mb-2 text-[13px] text-muted">
          Values go straight to Docker's secret store and are injected by the host proxy. They never enter the VM, and HQ never stores or shows them.
        </p>
        <ul className="mb-3 flex flex-col gap-1.5">
          {sb.secrets.length === 0 && <li className="text-[13px] text-muted">No secrets.</li>}
          {sb.secrets.map((s) => (
            <li key={s} className="flex items-center gap-2 border-2 border-ink bg-cream px-2 py-1">
              <span className="font-term text-[17px]">{s}</span>
              <span className="font-term text-[17px] text-muted">••••••••</span>
              <button className="btn ml-auto px-2 text-[12px]" onClick={() => officeActions.removeSecret(agent.id, s)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
        <form
          className="grid grid-cols-[1fr_1fr_auto] items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!secretName.trim() || !secretValue) return;
            officeActions.setSecret(agent.id, secretName, secretValue);
            setSecretName("");
            setSecretValue("");
          }}
        >
          <Field label="Name">
            <input className="field font-term text-[17px]" value={secretName} placeholder="STRIPE_SECRET_KEY" onChange={(e) => setSecretName(e.target.value.toUpperCase())} />
          </Field>
          <Field label="Value">
            <input className="field" type="password" autoComplete="off" value={secretValue} onChange={(e) => setSecretValue(e.target.value)} />
          </Field>
          <button className="btn" type="submit" disabled={!secretName.trim() || !secretValue}>
            Set secret
          </button>
        </form>
      </section>

      <section>
        <SectionTitle>What HQ will run</SectionTitle>
        <pre className="scroll-thin overflow-x-auto border-[3px] border-ink bg-navy-2 p-3 font-term text-[17px] leading-tight text-[#dfe6ff]">
{`${sb.resources.cpus || sb.resources.memoryGb ? `sbx run --cpus ${sb.resources.cpus ?? "auto"} --memory ${sb.resources.memoryGb ?? "auto"}g …   # size, set at creation\n` : ""}sbx policy set ${sb.policy}
sbx policy allow network localhost:${port},host.docker.internal:${port}   # added by HQ
${sb.allow.length ? `sbx policy allow network ${sb.allow.join(" ")}` : "# no extra allowed domains"}
${sb.deny.length ? `sbx policy deny network ${sb.deny.join(" ")}` : "# no blocked domains"}
${sb.secrets.map((s) => `sbx secret set ${s}   # value from your keychain`).join("\n") || "# no secrets"}`}
        </pre>
        <p className="mt-1 text-[12px] text-muted">Preview. Exact sbx command syntax is confirmed when the real backend is built.</p>
      </section>
    </div>
  );
}
