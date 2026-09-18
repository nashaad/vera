import { createRoot } from "react-dom/client";

import { UsageApp } from "./App.tsx";
import { RunsApp } from "./RunsPage.tsx";

const root = document.getElementById("root");
if (root === null) {
    throw new Error("Annex page has no #root");
}
const runs = window.location.pathname.startsWith("/runs");
document.title = runs ? "Vera · Runs" : "Vera · Usage";
createRoot(root).render(runs ? <RunsApp /> : <UsageApp />);
