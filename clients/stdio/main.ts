import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

import {
    configuredModelFallback,
    configuredReviewer,
    loadVeraConfig,
    type VeraConfig,
} from "../../src/config.ts";
import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import { createConfiguredModelAdapter } from "../../src/providers/configured.ts";
import { ProviderRoutingAdapter } from "../../src/providers/routing.ts";
import {
    createStdioApprovalResponse,
    renderStdioApproval,
} from "./approval.ts";
import {
    createStdioQuestionResponse,
    renderStdioQuestion,
} from "./question.ts";
import { renderStdioTaskNotification } from "./notification.ts";

interface StdioLineInput {
    readonly type: "line";
    readonly value: string;
}

interface StdioEndInput {
    readonly type: "end";
}

type StdioInput = StdioLineInput | StdioEndInput;

const config = loadVeraConfig();
const defaultProvider = config.provider ?? "openrouter";
// Routed, matching the resident host. The reviewer can be configured on a
// different provider than the agent, and a fixed adapter would silently send
// those reviews to the agent's backend under the reviewer's model name.
const adapter = new ProviderRoutingAdapter(
    (provider) => createConfiguredModelAdapter({
        ...config,
        provider: provider as VeraConfig["provider"],
    }),
    defaultProvider,
);
const channel = createInProcessChannel();
const lines = createInterface({
    input: stdin,
    output: stdout,
    prompt: "vera> ",
});
const inputLines = new AsyncQueue<StdioInput>();
lines.on("line", (value) => inputLines.push({ type: "line", value }));
lines.on("close", () => inputLines.push({ type: "end" }));

try {
    void runHeadlessLoop(
        channel.engine,
        adapter,
        config.model,
        config.reasoning_effort,
        {
            approvalMode: config.approval_mode,
            modelFallback: configuredModelFallback(config),
            ...(configuredReviewer(config) === undefined
                ? {}
                : { reviewer: configuredReviewer(config)! }),
            ...(config.disabled_prompt_contributions === undefined
                ? {}
                : {
                    disabledPromptContributions:
                        config.disabled_prompt_contributions,
                }),
        },
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

        let bufferedUpdate: AgentUpdate | undefined;
        while (true) {
            const update = bufferedUpdate ?? await channel.client.receive();
            bufferedUpdate = undefined;

            if (update.type === "assistant_delta") {
                stdout.write(update.text);
            }

            if (update.type === "task_notification") {
                stdout.write(renderStdioTaskNotification(update));
            }

            if (update.type === "tool_review") {
                stdout.write(
                    update.decision === "unavailable"
                        ? `\n[reviewer unavailable for ${update.tool}:`
                            + ` ${update.reason}]\n`
                        : `\n[reviewer ${update.decision === "allow" ? "allowed" : "denied"}`
                            + ` ${update.tool} (${update.riskLevel} risk):`
                            + ` ${update.reason}]\n`,
                );
            }

            if (update.type === "ui_request") {
                if (update.request.type === "tool_approval") {
                    stdout.write(`\n${renderStdioApproval(update)}\n`);
                    lines.setPrompt(
                        update.request.permissionGrants === undefined
                            ? "Choose [1 once/3 deny] "
                            : "Choose [1 once/2 similar this session/3 deny/4 similar always] ",
                    );
                    lines.prompt();
                    const waiting = new AbortController();
                    const answerOrUpdate = await Promise.race([
                        inputLines.receive(waiting.signal).then((answer) => ({
                            type: "answer" as const,
                            answer,
                        })),
                        channel.client.receive(waiting.signal).then(
                            (nextUpdate) => ({
                                type: "update" as const,
                                update: nextUpdate,
                            }),
                        ),
                    ]);
                    waiting.abort();

                    if (answerOrUpdate.type === "answer") {
                        const answer = answerOrUpdate.answer;
                        inputEnded = answer.type === "end";
                        channel.client.send(createStdioApprovalResponse(
                            update,
                            answer.type === "line" ? answer.value : undefined,
                        ));
                    } else {
                        stdout.write("\nApproval request closed.\n");
                        bufferedUpdate = answerOrUpdate.update;
                    }
                } else {
                    stdout.write(`\n${renderStdioQuestion(update)}\n`);
                    lines.setPrompt(
                        `Choose [1-${update.request.choices.length}] or c: `,
                    );
                    let answered = false;
                    while (!answered) {
                        lines.prompt();
                        const waiting = new AbortController();
                        const answerOrUpdate = await Promise.race([
                            inputLines.receive(waiting.signal).then((answer) => ({
                                type: "answer" as const,
                                answer,
                            })),
                            channel.client.receive(waiting.signal).then(
                                (nextUpdate) => ({
                                    type: "update" as const,
                                    update: nextUpdate,
                                }),
                            ),
                        ]);
                        waiting.abort();
                        if (answerOrUpdate.type === "update") {
                            stdout.write("\nQuestion closed.\n");
                            bufferedUpdate = answerOrUpdate.update;
                            answered = true;
                            continue;
                        }
                        const answer = answerOrUpdate.answer;
                        inputEnded = answer.type === "end";
                        const response = createStdioQuestionResponse(
                            update,
                            answer.type === "line" ? answer.value : undefined,
                        );
                        if (response === undefined) {
                            stdout.write("Choose a displayed number or c.\n");
                            continue;
                        }
                        channel.client.send(response);
                        answered = true;
                    }
                }
                lines.setPrompt("vera> ");
            }

            if (update.type === "ui_request_closed") {
                continue;
            }

            if (update.type === "turn_finished") {
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
}
