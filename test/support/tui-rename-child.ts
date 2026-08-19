import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
    startTui,
    type TuiAgentClient,
    type TuiDependencies,
} from "../../clients/tui/main.ts";
import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";

export function createTuiRenameDependencies(home: string): TuiDependencies {
    const updates = new AsyncQueue<AgentUpdate>();
    const commands: string[] = [];
    updates.push({ type: "history", entries: [], seq: 0 });

    const client: TuiAgentClient = {
        async send(command): Promise<void> {
            if (command.type === "update_session_name") {
                commands.push(command.name === null ? "<clear>" : command.name);
                updates.push({
                    type: "session_name",
                    requestId: command.requestId,
                    name: command.name,
                });
                return;
            }
            if (command.type === "prompt") {
                commands.push(`PROMPT:${command.content}`);
            }
        },
        receive(signal) {
            return updates.receive(signal);
        },
        async detach(): Promise<void> {
            await writeFile(
                join(home, "rename-result.txt"),
                commands.join("\n"),
            );
        },
        close(): void {},
    };

    return { client };
}

if (import.meta.main) {
    await startTui(createTuiRenameDependencies(process.env.HOME ?? "."));
}
