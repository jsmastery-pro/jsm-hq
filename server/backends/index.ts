import { tmuxBackend } from "./tmux";
import type { SessionBackend } from "./types";

export type { LaunchSpec, SessionBackend, TermHandle } from "./types";

export function sessionBackend(): SessionBackend {
  return tmuxBackend;
}
