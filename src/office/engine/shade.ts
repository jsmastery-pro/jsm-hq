// Recolours office pixels for the active theme. Every draw goes through a Pen, and every Pen
// passes its colour through shade(), so one function themes the whole canvas.

import { currentTheme } from "../../theme/theme";

const cache = new Map<string, string>();

/** Moonlight the night theme blends towards. */
const NIGHT_TINT = { r: 28, g: 26, b: 70 };
/** How much of the original colour survives at night. */
const NIGHT_KEEP = 0.5;

function parse(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

const toHex = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");

/**
 * Lights stay lit at night: saturated, bright colours (LEDs, screens, status colours,
 * agents' colours, sticky notes) and near-white text. Everything else is a surface.
 */
function isLight({ r, g, b }: { r: number; g: number; b: number }): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const value = max / 255;
  const sat = max === 0 ? 0 : (max - min) / max;
  return (sat > 0.6 && value > 0.75) || (value > 0.93 && sat < 0.12);
}

function night(hex: string): string {
  const c = parse(hex);
  if (!c || isLight(c)) return hex;
  const mix = (v: number, t: number) => v * NIGHT_KEEP + t * (1 - NIGHT_KEEP) * 0.6;
  return `#${toHex(mix(c.r, NIGHT_TINT.r))}${toHex(mix(c.g, NIGHT_TINT.g))}${toHex(mix(c.b, NIGHT_TINT.b))}`;
}

export function shade(color: string): string {
  if (currentTheme() === "classic") return color;
  let out = cache.get(color);
  if (out === undefined) {
    out = night(color);
    cache.set(color, out);
  }
  return out;
}
