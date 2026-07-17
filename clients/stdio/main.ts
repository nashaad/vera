import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

import { loadVeraConfig } from "../../src/config.ts";
import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type { AgentFrame } from "../../src/engine/frames.ts";
import { createInProcessChannel } from "../../src/engine/in-process-channel.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import { createInstanceDirectory } from "../../src/instances/directory.ts";
import { createConfiguredModelAdapter } from "../../src/providers/configured.ts";
import {
    createStdioApprovalResponse,
    renderStdioApproval,
} from "./approval.ts";

interface StdioLineInput {
    readonly type: "line";
    readonly value: string;
}

interface StdioEndInput {
    readonly type: "end";
}

type StdioInput = StdioLineInput | StdioEndInput;

const config = loadVeraConfig();
const adapter = createConfiguredModelAdapter(config);
const channel = createInProcessChannel();
const lines = createInterface({
    input: stdin,
    output: stdout,
    prompt: "vera> ",
});
const inputLines = new AsyncQueue<StdioInput>();
lines.on("line", (value) => inputLines.push({ type: "line", value }));
lines.on("close", () => inputLines.push({ type: "end" }));
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
        { approvalMode: config.approval_mode },
    );
    lines.prompt();

    let inputEnded = false;
    while (!inputEnded) {
        const input = await inputLines.receive();
        if (input.type === "end") {
            break;
        }
        const line = input.value;
        const command = line.trim().toLowerCase();

        if (command === "q" || command === "exit") {
            break;
        }

        if (command === "") {
            lines.prompt();
            continue;
        }

        channel.client.send({ type: "prompt", content: line });

        let bufferedFrame: AgentFrame | undefined;
        while (true) {
            const frame = bufferedFrame ?? await channel.client.receive();
            bufferedFrame = undefined;

            if (frame.type === "assistant_delta") {
                stdout.write(frame.text);
            }

            if (frame.type === "ui_request") {
                stdout.write(`\n${renderStdioApproval(frame)}\n`);
                lines.setPrompt("Allow? [y/N] ");
                lines.prompt();
                const waiting = new AbortController();
                const answerOrFrame = await Promise.race([
                    inputLines.receive(waiting.signal).then((answer) => ({
                        type: "answer" as const,
                        answer,
                    })),
                    channel.client.receive(waiting.signal).then((nextFrame) => ({
                        type: "frame" as const,
                        frame: nextFrame,
                    })),
                ]);
                waiting.abort();

                if (answerOrFrame.type === "answer") {
                    const answer = answerOrFrame.answer;
                    inputEnded = answer.type === "end";
                    channel.client.send(createStdioApprovalResponse(
                        frame,
                        answer.type === "line" ? answer.value : undefined,
                    ));
                } else {
                    stdout.write("\nApproval request closed.\n");
                    bufferedFrame = answerOrFrame.frame;
                }
                lines.setPrompt("vera> ");
            }

            if (frame.type === "ui_request_closed") {
                continue;
            }

            if (frame.type === "turn_finished") {
                break;
            }
        }

        stdout.write("\n");
        if (!inputEnded) {
            lines.prompt();
        }
    }
} finally {
    lines.close();
    presence.remove();
}
