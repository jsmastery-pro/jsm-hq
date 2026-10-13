import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";
import { ui, useUi } from "../../store/ui";
import { AgentDrawer } from "./AgentDrawer";
import { BoardsDrawer } from "./BoardsDrawer";
import { EnvironmentDrawer } from "./EnvironmentDrawer";
import { PrDrawer } from "./PrDrawer";

export function DrawerHeader({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 border-b-[3px] border-ink px-3 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">{children}</div>
      <button className="btn px-2.5" aria-label="Close" onClick={() => ui.closeDrawer()}>
        ✕
      </button>
    </div>
  );
}

export function DrawerHost() {
  const drawer = useUi((s) => s.drawer);
  const reduce = useReducedMotion();
  const key = drawer ? (drawer.kind === "agent" ? `agent:${drawer.id}` : drawer.kind === "env" ? `env:${drawer.name}` : drawer.kind) : null;

  return (
    <AnimatePresence mode="wait">
      {drawer && (
        <motion.aside
          key={key}
          initial={reduce ? false : { x: 560 }}
          animate={{ x: 0 }}
          exit={reduce ? { opacity: 0 } : { x: 560 }}
          transition={{ duration: reduce ? 0 : 0.28, ease: [0.3, 0, 0.2, 1] }}
          className="panel fixed bottom-4 right-4 top-[74px] z-20 flex w-[520px] flex-col"
          aria-label="Details"
        >
          {drawer.kind === "agent" && <AgentDrawer id={drawer.id} initialTab={drawer.tab} />}
          {drawer.kind === "boards" && <BoardsDrawer initialBoardId={drawer.boardId} />}
          {drawer.kind === "prs" && <PrDrawer />}
          {drawer.kind === "env" && <EnvironmentDrawer name={drawer.name} />}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
