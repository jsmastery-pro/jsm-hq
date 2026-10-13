import { useEffect } from "react";
import { OfficeCanvas } from "./office/OfficeCanvas";
import { connectOffice, useOffice } from "./store/office";
import { ui, useUi } from "./store/ui";
import { DebugPanel } from "./ui/DebugPanel";
import { DrawerHost } from "./ui/drawers/Drawer";
import { ActivityFeed } from "./ui/hud/ActivityFeed";
import { TeamPanel } from "./ui/hud/TeamPanel";
import { Tooltip } from "./ui/hud/Tooltip";
import { TopBar } from "./ui/hud/TopBar";
import { SettingsModal } from "./ui/settings/SettingsModal";

function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      // Never steal keys from inputs or the terminal.
      if (el && (el.closest("input, textarea, select, [contenteditable], .xterm") || e.metaKey || e.ctrlKey || e.altKey)) {
        if (e.key === "Escape" && el.closest(".xterm")) el.blur();
        return;
      }
      const { settings, drawer } = useUi.getState();
      if (e.key === "Escape") {
        if (settings) ui.closeSettings();
        else if (drawer) ui.closeDrawer();
        return;
      }
      if (settings) return;
      let handled = true;
      if (e.key === "d" || e.key === "D") ui.toggleDebug();
      else if (e.key === "+" || e.key === "=") ui.zoom(1);
      else if (e.key === "-") ui.zoom(-1);
      else if (/^[1-9]$/.test(e.key)) {
        const team = useOffice.getState().snap?.config.team ?? [];
        const agent = team[Number(e.key) - 1];
        if (agent) ui.openAgent(agent.id);
      } else handled = false;
      // The drawer focuses its terminal; don't let this key land in it too.
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function App() {
  useEffect(() => connectOffice(), []);
  useKeyboard();
  const ready = useOffice((s) => s.snap !== null);

  return (
    <>
      <OfficeCanvas />
      {ready && (
        <>
          <TopBar />
          <TeamPanel />
          <ActivityFeed />
          <DrawerHost />
          <DebugPanel />
          <SettingsModal />
          <Tooltip />
        </>
      )}
    </>
  );
}
