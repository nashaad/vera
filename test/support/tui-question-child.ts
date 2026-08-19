import {
    startTui,
    type TuiAgentClient,
    type TuiDependencies,
} from "../../clients/tui/main.ts";
import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type {
    AgentUpdate,
    ClientCommand,
} from "../../src/engine/protocol.ts";

export function createTuiQuestionDependencies(): TuiDependencies {
    const requestId = "choice-question";
    const updates = new AsyncQueue<AgentUpdate>();
    let seq = 0;
    let modelSettingsSent = false;
    let permissionsSent = false;
    let questionScheduled = false;

    updates.push({ type: "history", entries: [], seq: seq++ });

    const client: TuiAgentClient = {
        async send(command: ClientCommand): Promise<void> {
            if (command.type === "get_model_settings") {
                modelSettingsSent = true;
                updates.push({
                    type: "model_settings",
                    requestId: command.requestId,
                    settings: { model: "faux/question", reasoningEffort: "high" },
                    pending: false,
                    seq: seq++,
                });
                scheduleQuestionWhenReady();
                return;
            }
            if (command.type === "get_permissions") {
                permissionsSent = true;
                updates.push({
                    type: "permissions",
                    requestId: command.requestId,
                    mode: "auto",
                    pending: false,
                    seq: seq++,
                });
                scheduleQuestionWhenReady();
                return;
            }
            if (
                command.type === "ui_response"
                && command.requestId === requestId
                && command.response.type === "user_question"
            ) {
                updates.push({
                    type: "ui_request_closed",
                    requestId,
                    seq: seq++,
                });
                const result = command.response.outcome === "selected"
                    ? `Selection received: ${command.response.choiceId}`
                    : "Cancellation received";
                updates.push({ type: "assistant_delta", text: result, seq: seq++ });
                return;
            }
            if (command.type === "prompt") {
                updates.push({
                    type: "assistant_delta",
                    text: command.content === "focus restored"
                        ? "FOCUS RESTORED"
                        : `Unexpected prompt: ${command.content}`,
                    seq: seq++,
                });
                updates.push({ type: "turn_finished", seq: seq++ });
            }
        },
        receive(signal) {
            return updates.receive(signal);
        },
        async detach(): Promise<void> {},
        close(): void {},
    };

    return { client };

    function scheduleQuestionWhenReady(): void {
        if (!modelSettingsSent || !permissionsSent || questionScheduled) {
            return;
        }
        questionScheduled = true;
        setTimeout(() => {
            updates.push({
                type: "ui_request",
                requestId,
                request: {
                    type: "user_question",
                    question: "Which release channel should Vera use?",
                    choices: [
                        { id: "stable-channel", label: "Stable" },
                        { id: "preview-channel", label: "Preview" },
                        { id: "nightly-channel", label: "Nightly" },
                    ],
                },
                seq: seq++,
            });
        }, 50);
}
}

if (import.meta.main) {
    await startTui(createTuiQuestionDependencies());
}
