import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";
import { applyFont, savedFont } from "./theme/fonts";
import { startTheme } from "./theme/theme";

applyFont(savedFont());
// Before the first render, so nothing flashes in the wrong theme. Lives for the page's lifetime.
startTheme();

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
