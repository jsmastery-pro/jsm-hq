// node-pty ships a prebuilt `spawn-helper` that some package managers unpack
// without the execute bit, which makes every spawn fail with "posix_spawnp failed".
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

try {
  const root = dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
  const prebuilds = join(root, "prebuilds");
  if (existsSync(prebuilds))
    for (const dir of readdirSync(prebuilds)) {
      const helper = join(prebuilds, dir, "spawn-helper");
      if (existsSync(helper)) chmodSync(helper, 0o755);
    }
} catch {
  // node-pty not installed (e.g. UI-only install) — nothing to fix.
}
