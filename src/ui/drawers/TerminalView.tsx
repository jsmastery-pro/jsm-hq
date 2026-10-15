import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { officeActions } from "../../store/office";
import { readTerminal, subscribeTerminal } from "../../store/terminal";

const theme = {
  background: "#16213f",
  foreground: "#dfe6ff",
  cursor: "#dfe6ff",
  cursorAccent: "#16213f",
  selectionBackground: "#2c3b6b",
  black: "#241a2e",
  red: "#ff5c86",
  green: "#6cf08a",
  yellow: "#ffc14d",
  blue: "#29adff",
  magenta: "#ff77a8",
  cyan: "#3ee0d0",
  white: "#dfe6ff",
};

/** A real xterm.js terminal fed by the agent's (mock) output stream. */
export function TerminalView({ agentId, autoFocus = true }: { agentId: string; autoFocus?: boolean }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    const term = new Terminal({
      theme,
      fontFamily: '"VT323", ui-monospace, Menlo, monospace',
      fontSize: 19,
      lineHeight: 1.05,
      cursorBlink: true,
      scrollback: 3000,
      convertEol: false,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    let unsub = () => {};
    let ro: ResizeObserver | null = null;

    // Measure with the pixel font loaded, or columns come out wrong.
    void document.fonts.load('19px "VT323"').finally(() => {
      if (disposed) return;
      term.open(el);
      fit.fit();
      // The server sizes the agent's tmux window to this terminal and redraws it.
      officeActions.resizeTerminal(agentId, term.cols, term.rows);
      term.onResize(({ cols, rows }) => officeActions.resizeTerminal(agentId, cols, rows));
      term.write(readTerminal(agentId));
      unsub = subscribeTerminal(agentId, (data) => term.write(data));
      term.onData((data) => officeActions.sendTerminalInput(agentId, data));
      ro = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          /* element hidden mid-animation */
        }
      });
      ro.observe(el);
      if (autoFocus) term.focus();
    });

    return () => {
      disposed = true;
      unsub();
      ro?.disconnect();
      term.dispose();
    };
  }, [agentId, autoFocus]);

  return <div ref={host} className="h-full min-h-0 w-full bg-navy-2" />;
}
