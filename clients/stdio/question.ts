import type {
    UiResponseCommand,
    UserQuestionUiRequestUpdate,
} from "../../src/engine/protocol.ts";

export function renderStdioQuestion(
    update: UserQuestionUiRequestUpdate,
): string {
    return [
        update.request.question,
        ...update.request.choices.map(
            (choice, index) => `${index + 1}. ${choice.label}`,
        ),
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
        return undefined;
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
