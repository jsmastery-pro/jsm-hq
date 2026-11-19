// Preset ROLE.md text for each catalog role (src/data/roles.ts). A preset is only a starting
// point: the user edits it in Settings → Team. HQ's rules for each kind live in the generated
// role (agentFiles.ts), so editing a preset can't break the workflow.

import backend from "./presets/backend";
import codeReviewer from "./presets/code-reviewer";
import designer from "./presets/designer";
import developer from "./presets/developer";
import devops from "./presets/devops";
import docs from "./presets/docs";
import frontend from "./presets/frontend";
import qa from "./presets/qa";
import security from "./presets/security";

const PRESETS: Record<string, string> = {
  developer,
  frontend,
  backend,
  designer,
  docs,
  devops,
  qa,
  "code-reviewer": codeReviewer,
  security,
};

/** The preset ROLE.md for a catalog role, with the agent's name filled in. */
export function presetRoleMd(roleId: string, name: string): string | null {
  const text = PRESETS[roleId];
  return text ? text.replaceAll("{{name}}", name).trim() : null;
}
