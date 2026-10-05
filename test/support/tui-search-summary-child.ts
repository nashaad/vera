import { startTui, type TuiAgentClient, type TuiDependencies } from "../../clients/tui/main.ts";
import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { installTestProcessGuard } from "./self-terminate-guard.ts";

export function createSearchSummaryDependencies(): TuiDependencies {
    const updates = new AsyncQueue<AgentUpdate>();
    let seq = 0;
    updates.push({ type: "history", entries: [], seq: seq++ });
    updates.push({ type: "status", state: "idle", seq: seq++ });
    const client: TuiAgentClient = {
        agentId: "search-preview",
        async send(command): Promise<void> {
            if (command.type === "get_model_settings") {
                updates.push({ type: "model_settings", requestId: command.requestId, settings: { model: "test" }, pending: false, seq: seq++ });
                return;
            }
            if (command.type === "get_permissions") {
                updates.push({ type: "permissions", requestId: command.requestId, mode: "ask", pending: false, seq: seq++ });
                return;
            }
            if (command.type !== "prompt") return;
            updates.push({ type: "status", state: "working", seq: seq++ });
            updates.push({ type: "assistant_delta", text: "Checking sample pack licensing.", seq: seq++ });
            for (const query of [
                "sample pack license royalty free loops license mechanism provenance source audio Loopmasters Splice Sounds license terms WAV metadata watermarking",
                "where sample pack producers record their original sounds",
                "site:loopmasters.com license royalty free original recordings",
            ]) {
                updates.push({ type: "assistant_thinking", text: "Checking source terms", seq: seq++ });
                await Bun.sleep(700);
                updates.push({ type: "tool_started", tool: "web_search", args: { query }, seq: seq++ });
                updates.push({ type: "tool_finished", tool: "web_search", output: "Provider: test\nLICENSE RESULT", seq: seq++ });
            }
            updates.push({ type: "turn_finished", outcome: "aborted", seq: seq++ });
            updates.push({ type: "status", state: "idle", seq: seq++ });
        },
        receive(signal): Promise<AgentUpdate> { return updates.receive(signal); },
        async detach(): Promise<void> {},
        close(): void {},
    };
    return { client };
}

if (import.meta.main) {
    installTestProcessGuard();
    await startTui(createSearchSummaryDependencies());
}
