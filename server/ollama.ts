// Local models through Ollama. An agent keeps its CLI (Claude Code or Codex) and only swaps
// where the model comes from: `provider: "ollama"` plus an `ollamaModel`. Claude Code talks to
// Ollama's Anthropic-compatible API, Codex to its OpenAI Responses API.

import { DEFAULT_OLLAMA_URL, supportsOllama, type AgentConfig, type HqConfig } from "../src/data/types";

/** The first Ollama release with the Anthropic Messages API, which Claude Code needs. */
export const OLLAMA_MIN_VERSION = "0.14.0";

/** Hosts that mean "this machine". Inside a sandbox that is the sandbox itself, not the host running Ollama. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

export const usesOllama = (agent: AgentConfig) => agent.provider === "ollama" && supportsOllama(agent.cli);

/** A usable http(s) address without a trailing slash, or null. For what the user typed. */
export function parseOllamaUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** Where HQ itself reaches Ollama (the project's setting, else the default). */
export const ollamaBaseUrl = (cfg: Pick<HqConfig, "project">) => parseOllamaUrl(cfg.project.ollamaUrl) ?? DEFAULT_OLLAMA_URL;

/** Where the agent reaches Ollama: a sandbox can't use localhost, it goes through host.docker.internal. */
export function ollamaUrlFor(agent: AgentConfig, cfg: Pick<HqConfig, "project">): string {
  const url = new URL(ollamaBaseUrl(cfg));
  if (agent.mode === "sandbox" && LOOPBACK.has(url.hostname)) url.hostname = "host.docker.internal";
  return url.toString().replace(/\/+$/, "");
}

/** host:port rules a sandbox needs to reach Ollama. The proxy treats host.docker.internal as localhost, so both are allowed. */
export function ollamaPolicyTargets(cfg: Pick<HqConfig, "project">): string[] {
  const url = new URL(ollamaBaseUrl(cfg));
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return LOOPBACK.has(url.hostname) ? [`host.docker.internal:${port}`, `localhost:${port}`] : [`${url.hostname}:${port}`];
}

/**
 * Claude Code's environment for Ollama. The token is a placeholder (Ollama ignores it). Claude Code
 * also calls its "haiku" and "sonnet" models for side tasks, so those names are mapped to the same
 * local model; otherwise Ollama would be asked for models it doesn't have. In Local mode an
 * ANTHROPIC_API_KEY from your own shell is blanked so it is never sent to Ollama.
 */
export function claudeOllamaEnv(agent: AgentConfig, cfg: Pick<HqConfig, "project">): Record<string, string> {
  const model = agent.ollamaModel?.trim() ?? "";
  return {
    ANTHROPIC_BASE_URL: ollamaUrlFor(agent, cfg),
    ANTHROPIC_AUTH_TOKEN: "ollama",
    ...(agent.mode === "local" ? { ANTHROPIC_API_KEY: "" } : {}),
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
  };
}

export interface OllamaStatus {
  version: string | null;
  /** Installed models; `tools` is false when this Ollama says the model can't call tools (undefined = not told). */
  models: { name: string; tools?: boolean }[];
}

/** Asks Ollama what it has (`GET /api/tags`, `/api/version`). null when it isn't reachable. */
export async function ollamaStatus(url: string): Promise<OllamaStatus | null> {
  const get = async (path: string) => {
    const res = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as Record<string, unknown>;
  };
  try {
    const tags = (await get("/api/tags")) as { models?: { name?: string; capabilities?: string[] }[] };
    const version = await get("/api/version").then((v) => (typeof v.version === "string" ? v.version : null), () => null);
    const models = (tags.models ?? []).flatMap((m) => (m.name ? [{ name: m.name, tools: m.capabilities ? m.capabilities.includes("tools") : undefined }] : []));
    return { version, models };
  } catch {
    return null;
  }
}

/** "qwen3-coder" means "qwen3-coder:latest", as in `ollama pull`. */
const withTag = (name: string) => (name.includes(":") ? name : `${name}:latest`);

export const findModel = (status: OllamaStatus, name: string) => status.models.find((m) => m.name === withTag(name.trim()));

/** True when `version` is older than `min` (both like "0.14.0"; anything unparsable counts as fine). */
export function olderThan(version: string | null, min: string): boolean {
  const nums = (v: string) => v.split("-")[0].split(".").map(Number);
  if (!version) return false;
  const [a, b] = [nums(version), nums(min)];
  if ([...a, ...b].some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}
