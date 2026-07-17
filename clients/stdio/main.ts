import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

import { loadVeraConfig } from "../../src/config.ts";
import { createInProcessChannel } from "../../src/engine/in-process-channel.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import { createInstanceDirectory } from "../../src/instances/directory.ts";
import { createConfiguredModelAdapter } from "../../src/providers/configured.ts";

const config = loadVeraConfig();
const adapter = createConfiguredModelAdapter(config);
const channel = createInProcessChannel();
const lines = createInterface({
    input: stdin,
    output: stdout,
    prompt: "vera> ",
});
const presence = createInstanceDirectory().register({
    client: "stdio",
    workspacePath: process.cwd(),
});

try {
    void runHeadlessLoop(
        channel.engine,
        adapter,
        config.model,
        config.reasoning_effort,
    );
    lines.prompt();

    for await (const line of lines) {
        const command = line.trim().toLowerCase();

        if (command === "q" || command === "exit") {
            break;
        }

        if (command === "") {
            lines.prompt();
            continue;
        }

        channel.client.send({ type: "prompt", content: line });

        while (true) {
            const frame = await channel.client.receive();

            if (frame.type === "assistant_delta") {
                stdout.write(frame.text);
            }

            if (frame.type === "turn_finished") {
                break;
            }
        }

        stdout.write("\n");
        lines.prompt();
    }
} finally {
    lines.close();
    presence.remove();
}
