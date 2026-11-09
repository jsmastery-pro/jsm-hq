// The project-room API: how any project (in any language) creates its room in the office and tells HQ what
// its workers are doing. Local only, with its own token (never the agents' or the browser's):
//   GET  /room         the room and its workers' latest status
//   PUT  /room         create or replace the room: { name, workers: [{ id?, name, kind?, color? }], demo? }
//   POST /room/event   { worker, state?, note?, ttl?, handoff?: { from?, to? } }

import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { agentPalette } from "../src/theme/tokens";
import type { ProjectRoomConfig, ProjectWorker, ProjectWorkerKind, RoomWorkerState, RoomWorkerStatus } from "../src/data/types";
import type { Hub } from "./hub";

const KINDS: ProjectWorkerKind[] = ["fetcher", "writer", "sender", "custom"];
const STATES: RoomWorkerState[] = ["idle", "working", "error", "done"];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const clip = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");

/** A project room from outside (the browser or a project): names clipped, kinds and ids checked, colors from the palette. */
export function cleanProjectRoom(raw: unknown): ProjectRoomConfig | null {
  const input = (raw ?? null) as Partial<ProjectRoomConfig> | null;
  if (!input || typeof input !== "object") return null;
  const used = new Set<string>();
  const workers = (Array.isArray(input.workers) ? input.workers : []).slice(0, 12).map((w, i): ProjectWorker => {
    const name = clip(w?.name, 40).trim() || "Worker";
    // A project may name its worker's id (so its events keep matching); otherwise it comes from the name.
    const base = slug(clip(w?.id, 40)) || slug(name) || "worker";
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    const kind = KINDS.includes(w?.kind as ProjectWorkerKind) ? (w.kind as ProjectWorkerKind) : "custom";
    const color = typeof w?.color === "string" && (agentPalette as readonly string[]).includes(w.color) ? w.color : agentPalette[(i + 3) % agentPalette.length];
    return { id, name, kind, color };
  });
  return { name: clip(input.name, 40).trim() || "Project", workers, ...(input.demo === false ? { demo: false } : {}) };
}

/** Sets (or removes) the room and forgets the status of workers that are gone. */
export function setRoom(hub: Hub, room: ProjectRoomConfig | null) {
  if (room) hub.snap.config.projectRoom = room;
  else delete hub.snap.config.projectRoom;
  const keep = new Set(room?.workers.map((w) => w.id));
  for (const id of Object.keys(hub.snap.roomWorkers ?? {})) if (!keep.has(id)) delete hub.snap.roomWorkers?.[id];
  hub.configChanged();
}

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) reject(new Error("too large"));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

interface EventBody {
  worker?: unknown;
  state?: unknown;
  note?: unknown;
  ttl?: unknown;
  handoff?: { from?: unknown; to?: unknown };
}

/** Handles /room requests. Returns false when the path isn't a room one. */
export async function handleRoomHttp(hub: Hub, token: string, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== "/room" && url.pathname !== "/room/event") return false;
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (!safeEqual(req.headers.authorization ?? "", `Bearer ${token}`)) return json(401, { error: "unauthorized: send the project-room token as a Bearer token" }), true;
  const room = () => hub.snap.config.projectRoom ?? null;
  try {
    if (url.pathname === "/room" && req.method === "GET") return json(200, { room: room(), status: hub.snap.roomWorkers ?? {} }), true;
    if (url.pathname === "/room" && req.method === "PUT") {
      const next = cleanProjectRoom(JSON.parse((await readBody(req)) || "null"));
      if (!next) return json(400, { error: "send { name, workers: [{ name, kind? }] }" }), true;
      setRoom(hub, next);
      return json(200, { room: next }), true;
    }
    if (url.pathname === "/room/event" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as EventBody;
      const workers = room()?.workers ?? [];
      const find = (v: unknown) => {
        const key = typeof v === "string" ? v.trim().toLowerCase() : "";
        return key ? workers.find((w) => w.id === key || w.name.toLowerCase() === key) : undefined;
      };
      if (!workers.length) return json(404, { error: "no project room yet: PUT /room first" }), true;
      const w = find(body.worker);
      if (body.worker !== undefined && !w) return json(404, { error: `no worker "${String(body.worker)}" in the room`, workers: workers.map((x) => x.id) }), true;
      if (w) {
        const state = STATES.includes(body.state as RoomWorkerState) ? (body.state as RoomWorkerState) : "working";
        const ttl = Math.min(3600, Math.max(1, Number(body.ttl) || (state === "done" ? 8 : 120)));
        const status: RoomWorkerStatus = { state, note: clip(body.note, 60).trim() || null, at: new Date().toISOString(), ttl };
        (hub.snap.roomWorkers ??= {})[w.id] = status;
        hub.emit({ type: "room.worker", workerId: w.id, status });
      }
      if (body.handoff) {
        const end = (v: unknown, dflt: string | null) => (v === "in" || v === "out" ? null : (find(v)?.id ?? dflt));
        const from = body.handoff.from === undefined ? (w?.id ?? null) : end(body.handoff.from, null);
        const to = end(body.handoff.to, null);
        const handoff = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, from, to };
        hub.snap.roomHandoffs = [handoff, ...(hub.snap.roomHandoffs ?? [])].slice(0, 20);
        hub.emit({ type: "room.handoff", handoff });
      }
      return json(200, { ok: true }), true;
    }
    return json(405, { error: "method not allowed" }), true;
  } catch {
    return json(400, { error: "bad request: send JSON" }), true;
  }
}
