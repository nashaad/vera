import { createRoot } from "react-dom/client";

import { UsageApp } from "./App.tsx";

const root = document.getElementById("root");
if (root === null) {
    throw new Error("Annex usage page has no #root");
}
createRoot(root).render(<UsageApp />);
