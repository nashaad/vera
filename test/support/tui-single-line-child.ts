import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTui } from "../../clients/tui/main.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { createSettingsAnsweringClient } from "./settings-answering-client.ts";
import { installTestProcessGuard } from "./self-terminate-guard.ts";

installTestProcessGuard();

let pushUpdate: ((update: AgentUpdate) => void) | undefined;
let sequence = 0;
let appended = 0;
process.on("SIGUSR1", () => {
    appended += 1;
    pushUpdate?.({
        type: "assistant_delta",
        text: Array.from({ length: 5 }, (_, index) =>
            `\nAPPENDED-LINE-${appended}-${index + 1}`
        ).join(""),
        seq: ++sequence,
    });
    writeFileSync(join(process.env.VERA_HOME!, `appended-${appended}`), "done");
});

const reply = Array.from({ length: 300 }, (_, index) =>
    `LINE${String(index + 1).padStart(3, "0")} the pirate crow checks the rigging`
).join("\n");

await startTui({
    client: createSettingsAnsweringClient({
        agentId: "single-line-scroll",
        model: "fixture",
        mode: "auto",
        onCommand: (command, push) => {
            if (command.type !== "prompt") return;
            pushUpdate = push;
            push({ type: "user_prompt", content: "long reply", seq: ++sequence });
            push({ type: "status", state: "working", seq: ++sequence });
            push({ type: "assistant_delta", text: reply, seq: ++sequence });
        },
    }),
    listAgents: async () => [],
});
