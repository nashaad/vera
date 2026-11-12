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
import "./styles/session-tools.css";
import "./styles/diffs.css";
import "./styles/right-views.css";
import "./styles/session-panes.css";
import "./styles/search.css";
import "./styles/workspace.css";
import "./styles/devices.css";
import "./styles/overlays.css";
import "./styles/palette.css";
import "./styles/customize.css";
import "./styles/settings-more.css";
import "./styles/dialogs.css";
import "./styles/tour.css";
import "./styles/coverage.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
    throw new Error("Desktop page has no #root");
}

createRoot(rootElement).render(<App />);
