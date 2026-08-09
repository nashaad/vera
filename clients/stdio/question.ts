import type {
    UiResponseCommand,
    UserQuestionUiRequestUpdate,
} from "../../src/engine/protocol.ts";

export function renderStdioQuestion(
    update: UserQuestionUiRequestUpdate,
): string {
    return [
        update.request.question,
        // A preview follows its own choice, indented under it: this client has
        // one column, so side by side is not available to it.
        ...update.request.choices.flatMap((choice, index) => [
            `${index + 1}. ${choice.label}`,
            ...(choice.description === undefined ? [] : [`   ${choice.description}`]),
            ...(choice.preview === undefined
                ? []
                : choice.preview.split("\n").map((line) => `   ${line}`)),
        ]),
        `${update.request.choices.length + 1}. Other (type your answer)`,
    ].join("\n");
}

export function createStdioQuestionResponse(
    update: UserQuestionUiRequestUpdate,
    answer: string | undefined,
): UiResponseCommand | undefined {
    const normalized = answer?.trim().toLowerCase();
    if (
        normalized === undefined
        || normalized === "c"
        || normalized === "cancel"
    ) {
        return {
            type: "ui_response",
            requestId: update.requestId,
            response: {
                type: "user_question",
                outcome: "cancelled",
            },
        };
    }
    const index = Number(normalized) - 1;
    const choice = Number.isInteger(index)
        ? update.request.choices[index]
        : undefined;
    if (choice === undefined) {
        return Number.isFinite(Number(normalized))
            ? undefined
            : {
                type: "ui_response",
                requestId: update.requestId,
                response: {
                    type: "user_question",
                    outcome: "custom",
                    text: answer!.trim(),
                },
            };
    }
    return {
        type: "ui_response",
        requestId: update.requestId,
        response: {
            type: "user_question",
            outcome: "selected",
            choiceId: choice.id,
        },
    };
}
