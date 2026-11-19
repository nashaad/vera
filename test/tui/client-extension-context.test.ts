import { expect, test } from "bun:test";

import { tuiContextStateForAgent } from "../../clients/tui/client-extension-context.ts";
import { createTuiState } from "../../clients/tui/state.ts";

test("client context resolves the requested visible agent independently of focus", () => {
    const main = createTuiState();
    const sidebar = createTuiState();
    const primaryAgent = { agentId: "main", state: main };
    const sidebarAgent = { agentId: "side", state: sidebar };

    expect(tuiContextStateForAgent({ agentId: "main" }, primaryAgent, sidebarAgent)).toBe(main);
    expect(tuiContextStateForAgent({ agentId: "side" }, primaryAgent, sidebarAgent)).toBe(sidebar);
    expect(tuiContextStateForAgent({ agentId: "missing" }, primaryAgent, sidebarAgent)).toBeUndefined();
    expect(tuiContextStateForAgent({ agentId: "side" }, primaryAgent)).toBeUndefined();
});
