// The project room's workers: non-AI characters (a mail fetcher, a writer on a local model, a sender…).
// A project reports what they do through the project-room API (see server/room.ts); the room then shows
// their real state, notes and hand-offs. Until a project connects, the room plays a looping demo of the
// pipeline (mail comes in, is written, then goes out) so it can be seen and designed first.

import { Sprite, type Container } from "pixi.js";
import type { ProjectWorkerKind, RoomHandoff, RoomWorkerState, RoomWorkerStatus } from "../../data/types";
import { robotSprites } from "../draw/robots";
import { drawScreen } from "../draw/live";
import { text, textW } from "../engine/font";
import { C } from "../engine/palette";
import { box, ellipse, type Pen } from "../engine/pen";
import type { OfficeLayout, ProjectStation, PxRect } from "../layout/layout";
import { tileCentre } from "../layout/layout";

const STEP = 2.4; // demo: seconds for one hop of the pipeline
const TRAVEL = 1.4; // of which the envelope is in the air
const BUSY = 1.8; // the worker then works on it
const FLIGHT = 1.2; // a real hand-off's flight, in seconds
const RANK: Record<ProjectWorkerKind, number> = { fetcher: 0, writer: 1, sender: 2, custom: 3 };

/** What the scene knows about the project's workers right now. */
export interface RoomView {
  statuses: Record<string, RoomWorkerStatus>;
  /** Play the demo while no project has reported anything. */
  demo: boolean;
}

interface Robot {
  station: ProjectStation;
  sprite: Sprite;
  textures: ReturnType<typeof robotSprites>["textures"];
  x: number;
  y: number;
}

interface Flight {
  from: { x: number; y: number };
  to: { x: number; y: number };
  t0: number;
}

const centre = (r: PxRect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

export class ProjectActors {
  private robots = new Map<string, Robot>();
  private flights: Flight[] = [];
  private key = "";

  /** Creates, restyles and removes the robots to match the layout's stations. */
  sync(l: OfficeLayout, layer: Container) {
    const room = l.projectRoom;
    const key = room ? room.stations.map((s) => `${s.id}|${s.color}|${s.kind}`).join(",") + `@${l.ox},${l.oy}` : "";
    if (key === this.key) return;
    this.key = key;
    this.clear();
    if (!room) return;
    for (const s of room.stations) {
      const sprites = robotSprites(s.color, false);
      const sprite = new Sprite(sprites.textures.back);
      layer.addChild(sprite);
      const c = tileCentre(l, s.stand);
      this.robots.set(s.id, { station: s, sprite, textures: sprites.textures, x: c.x, y: c.y });
    }
  }

  clear() {
    for (const r of this.robots.values()) r.sprite.destroy();
    this.robots.clear();
    this.flights = [];
  }

  private deskPos(l: OfficeLayout, id: string | null) {
    const room = l.projectRoom;
    if (!room) return null;
    if (id === null) return null;
    const s = room.stations.find((x) => x.id === id);
    return s ? { x: centre(s.desk).x, y: s.desk.y + 8 } : null;
  }

  /** A real hand-off: an envelope flies from one worker (or the in-tray) to another (or the out-tray). */
  handoff(l: OfficeLayout, h: RoomHandoff, t: number) {
    const room = l.projectRoom;
    if (!room) return;
    const from = h.from === null ? centre(room.inbox) : this.deskPos(l, h.from);
    const to = h.to === null ? centre(room.outbox) : this.deskPos(l, h.to);
    if (from && to) this.flights.push({ from, to, t0: t });
  }

  /** The demo's chain: inbox → fetcher → writer → sender → outbox. Workers outside it just work. */
  private chain(l: OfficeLayout): { nodes: { x: number; y: number }[]; stations: ProjectStation[] } {
    const room = l.projectRoom;
    if (!room) return { nodes: [], stations: [] };
    const stations = room.stations.filter((s) => s.kind !== "custom").sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.index - b.index);
    return { nodes: [centre(room.inbox), ...stations.map((s) => ({ x: centre(s.desk).x, y: s.desk.y + 8 })), centre(room.outbox)], stations };
  }

  private demoBusy(l: OfficeLayout, t: number): Set<string> {
    const { stations } = this.chain(l);
    const phase = t % ((stations.length + 1) * STEP + 1);
    const busy = new Set<string>();
    stations.forEach((s, j) => {
      const from = j * STEP + TRAVEL;
      if (phase >= from && phase < from + BUSY) busy.add(s.id);
    });
    return busy;
  }

  /** What each worker shows now: the project's real report (until it expires), or the demo. */
  private states(l: OfficeLayout, t: number, view: RoomView): Map<string, { state: RoomWorkerState; note: string | null }> {
    const out = new Map<string, { state: RoomWorkerState; note: string | null }>();
    const room = l.projectRoom;
    if (!room) return out;
    const live = Object.keys(view.statuses).length > 0 || !view.demo;
    const now = Date.now();
    const busy = live ? null : this.demoBusy(l, t);
    for (const s of room.stations) {
      if (busy) out.set(s.id, { state: s.kind === "custom" || busy.has(s.id) ? "working" : "idle", note: null });
      else {
        const r = view.statuses[s.id];
        out.set(s.id, !r || now - Date.parse(r.at) > r.ttl * 1000 ? { state: "idle", note: null } : { state: r.state, note: r.note });
      }
    }
    return out;
  }

  /** Moves the robots' sprites for this frame. */
  update(l: OfficeLayout, t: number, reduced: boolean, view: RoomView) {
    const states = this.states(l, t, view);
    for (const r of this.robots.values()) {
      const working = states.get(r.station.id)?.state === "working";
      const hover = 3 + (reduced ? 0 : Math.floor(t * 2.5 + r.station.index) % 2);
      r.sprite.texture = working && !reduced && Math.floor(t * 8) % 2 ? r.textures.type : r.textures.back;
      r.sprite.position.set(Math.round(r.x) - 6, Math.round(r.y) - 13 - hover);
      r.sprite.zIndex = Math.round(r.y);
    }
  }

  draw(p: Pen, shadow: Pen, l: OfficeLayout, t: number, reduced: boolean, view: RoomView) {
    const room = l.projectRoom;
    if (!room) return;
    const states = this.states(l, t, view);
    for (const s of room.stations) {
      const r = this.robots.get(s.id);
      const st = states.get(s.id) ?? { state: "idle" as const, note: null };
      if (r) ellipse(shadow, Math.round(r.x), Math.round(r.y) + 1, 4, 1, C.shadow, 0.3);
      const screen = st.state === "error" ? "needs-input" : st.state === "done" ? "review-passed" : st.state === "working" ? "working" : "idle";
      drawScreen(p, s.desk.x + 15, s.desk.y - 4, screen, s.color, reduced ? 0 : t, s.index);
      if (s.kind === "writer" && st.state === "working" && !reduced) p.rect(s.desk.x + 58, s.desk.y + 10, 14, 12, "#aaffee", 0.3 + 0.25 * Math.sin(t * 6));
      if (r && (st.state === "working" || st.state === "error")) bubble(p, r.x, r.y - 30, t, st.state === "error");
      if (st.note && st.state !== "idle") noteTag(p, centre(s.desk).x, s.desk.y + 63, st.note, st.state === "error");
    }
    if (reduced) return;
    this.drawDemoMail(p, l, t, view);
    this.flights = this.flights.filter((f) => t - f.t0 < FLIGHT);
    for (const f of this.flights) envelope(p, f.from, f.to, (t - f.t0) / FLIGHT);
  }

  /** The demo's envelope, hopping along the chain. Not drawn once a project is reporting. */
  private drawDemoMail(p: Pen, l: OfficeLayout, t: number, view: RoomView) {
    if (Object.keys(view.statuses).length > 0 || !view.demo) return;
    const { nodes } = this.chain(l);
    if (nodes.length < 2) return;
    const phase = t % ((nodes.length - 1) * STEP + 1);
    const hop = Math.floor(phase / STEP);
    const k = (phase - hop * STEP) / TRAVEL;
    if (hop >= nodes.length - 1 || k >= 1) return;
    envelope(p, nodes[hop], nodes[hop + 1], k);
  }
}

/** An envelope in flight, easing between two points along a small arc. k runs 0 → 1. */
function envelope(p: Pen, a: { x: number; y: number }, b: { x: number; y: number }, k: number) {
  const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
  const x = Math.round(a.x + (b.x - a.x) * e) - 4;
  const y = Math.round(a.y + (b.y - a.y) * e - Math.sin(e * Math.PI) * 22) - 3;
  p.rect(x, y, 9, 7, C.ink);
  p.rect(x + 1, y + 1, 7, 5, C.white);
  p.rect(x + 2, y + 2, 1, 1, C.pink);
  p.rect(x + 3, y + 3, 1, 1, C.pink);
  p.rect(x + 5, y + 2, 1, 1, C.pink);
}

/** A speech bubble: three dots that light up in turn when busy, an exclamation mark on an error. */
function bubble(p: Pen, cx: number, y: number, t: number, error: boolean) {
  const x = Math.round(cx) - 7;
  p.rect(x, y, 15, 9, C.ink);
  p.rect(x + 1, y + 1, 13, 7, error ? C.red : C.white);
  p.rect(Math.round(cx) - 1, y + 9, 3, 2, C.ink);
  if (error) {
    p.rect(x + 7, y + 2, 1, 3, C.white);
    p.rect(x + 7, y + 6, 1, 1, C.white);
    return;
  }
  for (let i = 0; i < 3; i++) p.rect(x + 3 + i * 4, y + 4, 2, 2, Math.floor(t * 4) % 3 === i ? C.ink : C.lav);
}

/** What the worker is doing, in a small label above its bubble. */
function noteTag(p: Pen, cx: number, y: number, note: string, error: boolean) {
  const label = note.toUpperCase().slice(0, 26);
  const w = textW(label);
  box(p, Math.round(cx - w / 2) - 3, y, w + 6, 9, error ? "#ffd0dc" : C.white);
  text(p, label, Math.round(cx - w / 2), y + 1, C.ink);
}
