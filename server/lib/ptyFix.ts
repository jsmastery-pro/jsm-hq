// node-pty ships a prebuilt `spawn-helper` that some installs unpack without the
// execute bit ("posix_spawnp failed"). The postinstall script fixes it; this
// repeats the fix at startup for package managers that skip install scripts.

import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export function ensurePtyHelperExecutable() {
  try {
    const root = dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
    const prebuilds = join(root, "prebuilds");
    if (!existsSync(prebuilds)) return;
    for (const dir of readdirSync(prebuilds)) {
      const helper = join(prebuilds, dir, "spawn-helper");
      if (existsSync(helper) && !(statSync(helper).mode & 0o111)) chmodSync(helper, 0o755);
    }
  } catch {
    // Best effort: if it still fails, the terminal shows the error.
  }
}
