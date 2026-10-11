import { createRoot } from "react-dom/client";

import { UsageApp } from "./App.tsx";
import { ExtensionPageApp } from "./ExtensionPage.tsx";
import { RunsApp } from "./RunsPage.tsx";

const root = document.getElementById("root");
if (root === null) {
    throw new Error("Annex page has no #root");
}
const pathname = window.location.pathname.replace(/\/+$/, "");
if (pathname.startsWith("/x/")) {
    document.title = "Vera";
    createRoot(root).render(<ExtensionPageApp path={pathname} />);
} else {
    const runs = pathname.startsWith("/runs");
    document.title = runs ? "Vera · Runs" : "Vera · Usage";
    createRoot(root).render(runs ? <RunsApp /> : <UsageApp />);
}
