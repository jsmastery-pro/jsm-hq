import { officeActions, useOffice } from "../../store/office";
import { Field, SectionTitle } from "../kit";
import { CommitInput } from "./controls";

export function ProjectSettings() {
  const project = useOffice((s) => s.snap?.config.project);
  if (!project) return null;
  return (
    <div className="flex flex-col gap-5">
      <section className="grid grid-cols-2 gap-3 border-[3px] border-ink bg-white p-3">
        <div className="col-span-2">
          <SectionTitle>Project</SectionTitle>
        </div>
        <Field label="Name">
          <CommitInput className="field" value={project.name} onCommit={(v) => v.trim() && officeActions.updateProject({ name: v.trim() })} />
        </Field>
        <Field label="GitHub repo" hint="owner/name. HQ only reads PRs, checks and comments.">
          <CommitInput className="field font-term text-[17px]" value={project.repo} onCommit={(v) => v.trim() && officeActions.updateProject({ repo: v.trim() })} />
        </Field>
        <Field label="Local path">
          <CommitInput className="field font-term text-[17px]" value={project.path} onCommit={(v) => v.trim() && officeActions.updateProject({ path: v.trim() })} />
        </Field>
        <Field label="HQ port" hint="Sandboxes reach HQ at host.docker.internal on this port.">
          <CommitInput
            className="field font-term text-[17px]"
            value={String(project.hqPort)}
            onCommit={(v) => {
              const n = Number(v);
              if (Number.isInteger(n) && n > 1023 && n < 65536) officeActions.updateProject({ hqPort: n });
            }}
          />
        </Field>
      </section>
      <section className="text-[13px] text-muted">
        <SectionTitle>Security</SectionTitle>
        <ul className="list-disc pl-5">
          <li>HQ binds 127.0.0.1 only.</li>
          <li>A random token is created on every start. The browser, hooks and the Team MCP must send it.</li>
          <li>HQ never reads .env files. Sandboxes get keys from Docker's secret store.</li>
        </ul>
      </section>
    </div>
  );
}
