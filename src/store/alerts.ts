// Tells the user when an agent starts waiting on them (state "needs-input": a question in its
// terminal, a website access request, a trust prompt), even when HQ isn't the window they're
// looking at: a short chime, and a count in the tab title. The sound is a per-browser choice,
// like the font, so it's saved in localStorage, not in .jsmhq/config.json.

import { useOffice } from "./office";

const KEY = "jsmhq.sound";
/** Two agents asking within this window ring once. */
const COOLDOWN_MS = 3000;

export function soundEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSoundEnabled(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    /* private window: applies until reload */
  }
}

let ctx: AudioContext | null = null;

/**
 * Browsers start audio suspended until the user interacts with the page. Create and resume the
 * context on the first click or key press, so a chime can play later while the tab is in the
 * background.
 */
function unlockAudio() {
  const unlock = () => {
    try {
      ctx ??= new AudioContext();
      void ctx.resume();
    } catch {
      /* no Web Audio: the title count still works */
    }
  };
  window.addEventListener("pointerdown", unlock, { once: true, capture: true });
  window.addEventListener("keydown", unlock, { once: true, capture: true });
  return () => {
    window.removeEventListener("pointerdown", unlock, { capture: true });
    window.removeEventListener("keydown", unlock, { capture: true });
  };
}

/** A soft two-note rising chime (about half a second). */
export function playChime() {
  if (!ctx || ctx.state !== "running") return;
  const t0 = ctx.currentTime;
  const notes: [number, number][] = [
    [660, 0],
    [990, 0.14],
  ];
  for (const [freq, at] of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t0 + at);
    gain.gain.linearRampToValueAtTime(0.18, t0 + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0 + at);
    osc.stop(t0 + at + 0.4);
  }
}

/** Start watching agents. Returns a cleanup function. */
export function watchNeedsInput(): () => void {
  const baseTitle = document.title;
  const stopUnlock = unlockAudio();
  let waiting: Set<string> | null = null; // null until the first snapshot: never ring on page load
  let lastRing = 0;

  const stop = useOffice.subscribe((s) => {
    if (!s.snap) return;
    const now = new Set(s.snap.agents.filter((a) => a.state === "needs-input").map((a) => a.agentId));
    document.title = now.size ? `(${now.size}) ${baseTitle}` : baseTitle;
    // Ring only for an agent that has just started waiting, not for ones already waiting.
    const fresh = waiting !== null && [...now].some((id) => !waiting?.has(id));
    if (fresh && soundEnabled() && Date.now() - lastRing > COOLDOWN_MS) {
      lastRing = Date.now();
      playChime();
    }
    waiting = now;
  });

  return () => {
    stop();
    stopUnlock();
    document.title = baseTitle;
  };
}
