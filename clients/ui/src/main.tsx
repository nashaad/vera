import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import "./styles/base.css";
import "./styles/titlebar.css";
import "./styles/banner.css";
import "./styles/panel.css";
import "./styles/statusbar.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
    throw new Error("Desktop page has no #root");
}

createRoot(rootElement).render(<App />);
