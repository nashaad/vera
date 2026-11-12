import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import "./styles/base.css";
import "./styles/titlebar.css";
import "./styles/banner.css";
import "./styles/panel.css";
import "./styles/workbench.css";
import "./styles/views.css";
import "./styles/sidebar-foot.css";
import "./styles/sidebar-nav.css";
import "./styles/pages.css";
import "./styles/transcript.css";
import "./styles/composer.css";
import "./styles/cards.css";
import "./styles/settings.css";
import "./styles/models.css";
import "./styles/models-browser.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
    throw new Error("Desktop page has no #root");
}

createRoot(rootElement).render(<App />);
