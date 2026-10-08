import { startTui, type TuiAgentClient, type TuiDependencies } from "../../clients/tui/main.ts";
import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { installTestProcessGuard } from "./self-terminate-guard.ts";

export function createReasoningTitlesDependencies(): TuiDependencies {
    const updates = new AsyncQueue<AgentUpdate>();
    let seq = 0;
    updates.push({ type: "history", entries: [], seq: seq++ });
    updates.push({ type: "status", state: "idle", seq: seq++ });
    const client: TuiAgentClient = {
        agentId: "reasoning-titles",
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
            updates.push({ type: "assistant_thinking", text: "**Plotting the course**", seq: seq++ });
            updates.push({ type: "assistant_thinking", text: "\n\n**Counting the doubloons**", seq: seq++ });
            updates.push({ type: "assistant_thinking", text: "\n\n**Raising the black flag**", seq: seq++ });
            await Bun.sleep(300);
            updates.push({ type: "tool_started", tool: "bash", args: { command: "ls treasure/" }, seq: seq++ });
            updates.push({ type: "tool_finished", tool: "bash", output: "map.txt", seq: seq++ });
            updates.push({ type: "assistant_delta", text: "The map is in the hold.", seq: seq++ });
            updates.push({ type: "turn_finished", seq: seq++ });
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
    await startTui(createReasoningTitlesDependencies());
}
