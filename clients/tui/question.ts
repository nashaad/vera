import {
    BoxRenderable,
    ScrollBoxRenderable,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import type {
    AgentUpdate,
    UiResponseCommand,
    UserQuestionUiRequestUpdate,
} from "../../src/engine/protocol.ts";
import { isUserQuestionUiRequestUpdate } from "../../src/engine/protocol.ts";
import { TUI_NOTICE, TUI_TEXT } from "./state.ts";

export interface TuiQuestionKey {
    readonly name: string;
    readonly sequence?: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly option?: boolean;
    readonly shift?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
}

export interface TuiQuestionView {
    readonly box: BoxRenderable;
    readonly details: ScrollBoxRenderable;
    readonly detailsText: TextRenderable;
    readonly actions: BoxRenderable;
    focus(): void;
    update(update: UserQuestionUiRequestUpdate): void;
}

export function createTuiQuestionView(
    renderer: RenderContext,
): TuiQuestionView {
    let currentRequestId: string | undefined;
    const detailsText = new TextRenderable(renderer, {
        id: "question-details-text",
        content: "",
        fg: TUI_TEXT,
        width: "100%",
        height: "auto",
        wrapMode: "word",
        selectable: true,
    });
    const details = new ScrollBoxRenderable(renderer, {
        id: "question-details",
        width: "100%",
        flexGrow: 1,
        minHeight: 1,
        scrollY: true,
        scrollX: false,
        viewportCulling: true,
        contentOptions: {
            flexDirection: "column",
        },
    });
    details.add(detailsText);

    const choiceAction = new TextRenderable(renderer, {
        id: "question-choice-action",
        content: "",
        fg: TUI_TEXT,
        width: "auto",
        height: 1,
        flexShrink: 0,
    });
    const cancelAction = new TextRenderable(renderer, {
        id: "question-cancel-action",
        content: "· [esc] cancel",
        fg: TUI_TEXT,
        width: "auto",
        height: 1,
        flexShrink: 0,
    });
    const actions = new BoxRenderable(renderer, {
        id: "question-actions",
        width: "100%",
        height: "auto",
        maxHeight: 2,
        flexShrink: 0,
        flexDirection: "row",
        flexWrap: "wrap",
    });
    actions.add(choiceAction);
    actions.add(cancelAction);
    const box = new BoxRenderable(renderer, {
        id: "question-box",
        title: " Question ",
        border: true,
        borderColor: TUI_NOTICE,
        backgroundColor: "#16161E",
        position: "absolute",
        bottom: 1,
        left: "5%",
        width: "90%",
        height: "auto",
        maxHeight: "90%",
        zIndex: 20,
        flexDirection: "column",
        gap: 0,
        paddingX: 1,
        visible: false,
    });
    box.add(details);
    box.add(actions);

    return {
        box,
        details,
        detailsText,
        actions,
        focus(): void {
            details.focus();
        },
        update(update): void {
            if (currentRequestId === update.requestId) {
                return;
            }
            currentRequestId = update.requestId;
            detailsText.content = renderTuiQuestionDetails(update);
            choiceAction.content = questionChoiceAction(update);
            details.scrollTo(0);
        },
    };
}

export function renderTuiQuestionDetails(
    update: UserQuestionUiRequestUpdate,
): string {
    return [
        update.request.question,
        "",
        ...update.request.choices.map(
            (choice, index) => `[${index + 1}] ${choice.label}`,
        ),
    ].join("\n");
}

export function createTuiQuestionResponse(
    update: UserQuestionUiRequestUpdate,
    key: TuiQuestionKey,
): UiResponseCommand | undefined {
    if (hasModifier(key)) {
        return undefined;
    }
    if (key.name === "escape") {
        return {
            type: "ui_response",
            requestId: update.requestId,
            response: {
                type: "user_question",
                outcome: "cancelled",
            },
        };
    }
    const value = key.sequence?.length === 1 ? key.sequence : key.name;
    const index = Number(value) - 1;
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

export function applyTuiQuestionUpdate(
    current: UserQuestionUiRequestUpdate | undefined,
    update: AgentUpdate,
): UserQuestionUiRequestUpdate | undefined {
    if (
        update.type === "ui_request"
        && isUserQuestionUiRequestUpdate(update)
    ) {
        return update;
    }
    if (
        update.type === "ui_request_closed"
        && current?.requestId === update.requestId
    ) {
        return undefined;
    }
    return current;
}

function questionChoiceAction(update: UserQuestionUiRequestUpdate): string {
    return `[1-${update.request.choices.length}] choose `;
}

function hasModifier(key: TuiQuestionKey): boolean {
    return key.ctrl === true
        || key.meta === true
        || key.option === true
        || key.shift === true
        || key.super === true
        || key.hyper === true;
}
