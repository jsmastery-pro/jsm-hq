// The project room's workers: non-AI characters (a mail fetcher, a writer on a local model, a sender…).
// For now they play a looping demo of the pipeline — mail comes in, is written, then goes out — so the
// room can be designed and seen before real events from a project are wired to it.

import { Sprite, type Container } from "pixi.js";
import type { ProjectWorkerKind } from "../../data/types";
import { robotSprites } from "../draw/robots";
import { drawScreen } from "../draw/live";
import { C } from "../engine/palette";
import { ellipse, type Pen } from "../engine/pen";
import type { OfficeLayout, ProjectStation, PxRect } from "../layout/layout";
import { tileCentre } from "../layout/layout";

const STEP = 2.4; // seconds for one hop of the pipeline
const TRAVEL = 1.4; // of which the envelope is in the air
const BUSY = 1.8; // the worker then works on it
const RANK: Record<ProjectWorkerKind, number> = { fetcher: 0, writer: 1, sender: 2, custom: 3 };

interface Robot {
  station: ProjectStation;
  sprite: Sprite;
  textures: ReturnType<typeof robotSprites>["textures"];
  x: number;
  y: number;
}

const centre = (r: PxRect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

export class ProjectActors {
  private robots = new Map<string, Robot>();
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
  }

  /** Mail moves along the chain inbox → fetcher → writer → sender → outbox. Workers outside it just work. */
  private chain(l: OfficeLayout): { nodes: { x: number; y: number }[]; stations: ProjectStation[] } {
    const room = l.projectRoom;
    if (!room) return { nodes: [], stations: [] };
    const stations = room.stations.filter((s) => s.kind !== "custom").sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.index - b.index);
    const desk = (s: ProjectStation) => ({ x: centre(s.desk).x, y: s.desk.y + 8 });
    return { nodes: [centre(room.inbox), ...stations.map(desk), centre(room.outbox)], stations };
  }

  private busyNow(l: OfficeLayout, t: number): Set<string> {
    const { stations } = this.chain(l);
    const cycle = (stations.length + 1) * STEP + 1;
    const phase = t % cycle;
    const busy = new Set<string>();
    stations.forEach((s, j) => {
      const from = j * STEP + TRAVEL;
      if (phase >= from && phase < from + BUSY) busy.add(s.id);
    });
    return busy;
  }

  /** Moves the robots' sprites for this frame. */
  update(l: OfficeLayout, t: number, reduced: boolean) {
    const busy = this.busyNow(l, t);
    for (const r of this.robots.values()) {
      const working = r.station.kind === "custom" || busy.has(r.station.id);
      const hover = 3 + (reduced ? 0 : Math.floor(t * 2.5 + r.station.index) % 2);
      r.sprite.texture = working && !reduced && Math.floor(t * 8) % 2 ? r.textures.type : r.textures.back;
      r.sprite.position.set(Math.round(r.x) - 6, Math.round(r.y) - 13 - hover);
      r.sprite.zIndex = Math.round(r.y);
    }
  }

  draw(p: Pen, shadow: Pen, l: OfficeLayout, t: number, reduced: boolean) {
    const room = l.projectRoom;
    if (!room) return;
    const busy = this.busyNow(l, t);
    for (const s of room.stations) {
      const r = this.robots.get(s.id);
      if (r) ellipse(shadow, Math.round(r.x), Math.round(r.y) + 1, 4, 1, C.shadow, 0.3);
      const working = s.kind === "custom" || busy.has(s.id);
      drawScreen(p, s.desk.x + 15, s.desk.y - 4, working ? "working" : "idle", s.color, reduced ? 0 : t, s.index);
      if (s.kind === "writer" && working && !reduced) {
        p.rect(s.desk.x + 58, s.desk.y + 10, 14, 12, "#aaffee", 0.3 + 0.25 * Math.sin(t * 6));
      }
      if (working && r) bubble(p, r.x, r.y - 30, t);
    }
    if (reduced) return;
    const { nodes } = this.chain(l);
    if (nodes.length < 2) return;
    const cycle = (nodes.length - 1) * STEP + 1;
    const phase = t % cycle;
    const hop = Math.floor(phase / STEP);
    const k = (phase - hop * STEP) / TRAVEL;
    if (hop >= nodes.length - 1 || k >= 1) return;
    const a = nodes[hop];
    const b = nodes[hop + 1];
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    const x = Math.round(a.x + (b.x - a.x) * e) - 4;
    const y = Math.round(a.y + (b.y - a.y) * e - Math.sin(e * Math.PI) * 22) - 3;
    p.rect(x, y, 9, 7, C.ink);
    p.rect(x + 1, y + 1, 7, 5, C.white);
    p.rect(x + 2, y + 2, 1, 1, C.pink);
    p.rect(x + 3, y + 3, 1, 1, C.pink);
    p.rect(x + 5, y + 2, 1, 1, C.pink);
  }
}

/** A speech bubble with three dots that light up in turn: the worker is busy. */
function bubble(p: Pen, cx: number, y: number, t: number) {
  const x = Math.round(cx) - 7;
  p.rect(x, y, 15, 9, C.ink);
  p.rect(x + 1, y + 1, 13, 7, C.white);
  p.rect(Math.round(cx) - 1, y + 9, 3, 2, C.ink);
  for (let i = 0; i < 3; i++) p.rect(x + 3 + i * 4, y + 4, 2, 2, Math.floor(t * 4) % 3 === i ? C.ink : C.lav);
}
