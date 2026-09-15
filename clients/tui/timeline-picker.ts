import { DIALOG_SEARCH_HEIGHT, dialogSearchHeight } from "./dialog-search.ts";
import {
    BoxRenderable,
    type KeyEvent,
    type Renderable,
    type RenderContext,
    TextRenderable,
} from "@opentui/core";

import type {
    ClientCommand,
    TimelineActionPlan,
    TimelineBoundary,
    TimelineReplyUpdate,
} from "../../src/engine/protocol.ts";
import { TUI_NOTICE, TUI_PANEL, TUI_TEXT } from "./state.ts";
import {
    DIALOG_CARD_Z_INDEX,
    dialogFooterNode,
    dialogHeaderNode,
    dialogInsetBottomOffset,
    dialogInsetTop,
    dialogRowPointer,
    type DialogRowPointer,
    dialogOptionRow,
    createDialogSearchNode,
    updateDialogSearchNode,
} from "./dialog-chrome.ts";
import {
    insertTuiSingleLinePaste,
    tuiTextareaKey,
} from "./single-line-editor.ts";

interface TimelinePickerBase {
    readonly operation?: "rewind" | "fork";
    readonly boundaries: readonly TimelineBoundary[];
    readonly query: string;
    readonly queryCursor?: number;
    readonly selectedIndex: number;
    readonly notice?: string;
}

export interface TimelinePickerLoadingState {
    readonly screen: "loading";
    readonly operation?: "rewind" | "fork";
    readonly requestId: string;
    readonly notice?: string;
}

export interface TimelinePickerSelectState extends TimelinePickerBase {
    readonly screen: "select";
}

export interface TimelinePickerActionsState extends TimelinePickerBase {
    readonly screen: "actions";
    readonly selectedAction: "rewind" | "cancel";
}

export interface TimelinePickerPreviewingState extends TimelinePickerBase {
    readonly screen: "previewing";
    readonly requestId: string;
}

export interface TimelinePickerConfirmState extends TimelinePickerBase {
    readonly screen: "confirm";
    readonly plan: TimelineActionPlan;
}

export interface TimelinePickerApplyingState extends TimelinePickerBase {
    readonly screen: "applying";
    readonly requestId: string;
    readonly plan: TimelineActionPlan;
}

export type TuiTimelinePickerState =
    | TimelinePickerLoadingState
    | TimelinePickerSelectState
    | TimelinePickerActionsState
    | TimelinePickerPreviewingState
    | TimelinePickerConfirmState
    | TimelinePickerApplyingState;

export interface TuiTimelinePickerTransition {
    readonly state?: TuiTimelinePickerState;
    readonly command?: ClientCommand;
    readonly composerText?: string;
    readonly forkBoundaryId?: string;
    readonly handled: boolean;
}

export interface TuiTimelinePickerView {
    readonly box: BoxRenderable;
    pointer?: DialogRowPointer;
    focus(): void;
    handleEditorKey(
        state: TuiTimelinePickerState,
        key: Pick<
            KeyEvent,
            "name" | "sequence" | "ctrl" | "meta" | "shift" | "super" | "hyper"
        >,
    ): TuiTimelinePickerTransition;
    handleEditorPaste(
        state: TuiTimelinePickerState,
        text: string,
    ): TuiTimelinePickerTransition;
    update(state: TuiTimelinePickerState): void;
}

export function startTuiTimelinePicker(
    requestId: string,
    operation: "rewind" | "fork" = "rewind",
): TuiTimelinePickerTransition {
    return {
        state: { screen: "loading", requestId, operation },
        command: { type: "list_timeline", requestId },
        handled: true,
    };
}

export function applyTuiTimelineReply(
    state: TuiTimelinePickerState,
    update: TimelineReplyUpdate,
    createRequestId: () => string,
): TuiTimelinePickerTransition {
    if (state.screen === "loading") {
        if (update.type !== "timeline" || update.requestId !== state.requestId) {
            return unchanged(state);
        }
        const boundaries = [...update.boundaries].reverse();
        return {
            state: {
                screen: "select",
                operation: state.operation,
                boundaries,
                query: "",
                queryCursor: 0,
                selectedIndex: 0,
            },
            handled: true,
        };
    }

    if (state.screen === "previewing") {
        if (update.requestId !== state.requestId) {
            return unchanged(state);
        }
        if (update.type === "timeline_action_preview") {
            return {
                state: {
                    ...baseState(state),
                    screen: "confirm",
                    plan: update.plan,
                },
                handled: true,
            };
        }
        if (
            update.type === "timeline_action_rejected"
            && update.operation === "preview"
        ) {
            if (requiresRefresh(update.reason)) {
                return refreshTimeline(update.reason, createRequestId);
            }
            return {
                state: {
                    ...baseState(state),
                    screen: "actions",
                    selectedAction: "rewind",
                    notice: rejectionNotice(update.reason),
                },
                handled: true,
            };
        }
        return unchanged(state);
    }

    if (state.screen === "applying") {
        if (update.requestId !== state.requestId) {
            return unchanged(state);
        }
        if (
            update.type === "timeline_action_applied"
            && update.planId === state.plan.planId
        ) {
            return {
                composerText: state.plan.boundary.prompt,
                handled: true,
            };
        }
        if (
            update.type === "timeline_action_rejected"
            && update.operation === "apply"
        ) {
            if (requiresRefresh(update.reason)) {
                return refreshTimeline(update.reason, createRequestId);
            }
            return {
                state: {
                    ...baseState(state),
                    screen: "confirm",
                    plan: state.plan,
                    notice: rejectionNotice(update.reason),
                },
                handled: true,
            };
        }
    }

    return unchanged(state);
}

export function handleTuiTimelineKey(
    state: TuiTimelinePickerState,
    key: Pick<
        KeyEvent,
        "name" | "sequence" | "ctrl" | "meta" | "super" | "hyper"
    >,
    createRequestId: () => string,
): TuiTimelinePickerTransition {
    if (hasCommandModifier(key)) {
        return unchanged(state, false);
    }
    if (key.name === "escape") {
        return escapeTimelineScreen(state);
    }
    if (state.screen === "loading" || state.screen === "previewing"
        || state.screen === "applying") {
        return unchanged(state, false);
    }
    if (state.screen === "select") {
        return handleSelectKey(state, key);
    }
    if (state.screen === "actions") {
        return handleActionsKey(state, key, createRequestId);
    }
    return handleConfirmKey(state, key, createRequestId);
}

export function createTuiTimelinePickerView(
    renderer: RenderContext,
): TuiTimelinePickerView {
    let nodes: Renderable[] = [];
    let shownScreen: TuiTimelinePickerState["screen"] = "loading";
    const search = createDialogSearchNode(renderer, "timeline-picker-search");
    const box = new BoxRenderable(renderer, {
        id: "timeline-picker",
        border: false,
        backgroundColor: TUI_PANEL,
        position: "absolute",
        top: dialogInsetTop(renderer),
        left: "5%",
        width: "90%",
        height: "auto",
        maxHeight: renderer.height - dialogInsetTop(renderer)
            - dialogInsetBottomOffset(renderer),
        zIndex: DIALOG_CARD_Z_INDEX,
        flexDirection: "column",
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        focusable: true,
        visible: false,
    });

    const view: TuiTimelinePickerView = {
        box,
        focus(): void {
            if (shownScreen === "select") search.editor.focus();
            else box.focus();
        },
        handleEditorKey(state, key): TuiTimelinePickerTransition {
            if (
                state.screen !== "select" || key.name === "escape"
                || key.name === "up" || key.name === "down"
                || key.name === "return" || key.name === "enter"
                || key.name === "kpenter"
            ) {
                return unchanged(state, false);
            }
            if (!search.editor.handleKeyPress(tuiTextareaKey(key))) {
                return unchanged(state, false);
            }
            return updateTuiTimelineSearch(
                state,
                search.editor.plainText,
                search.editor.cursorOffset,
            );
        },
        handleEditorPaste(state, text): TuiTimelinePickerTransition {
            if (state.screen !== "select") return unchanged(state, false);
            insertTuiSingleLinePaste(search.editor, text);
            return changed({
                ...state,
                query: search.editor.plainText,
                queryCursor: search.editor.cursorOffset,
                selectedIndex: 0,
                notice: undefined,
            });
        },
        update(state): void {
            shownScreen = state.screen;
            box.paddingTop = state.screen === "select" && renderer.height < 30 ? 0 : 1;
            search.box.parent?.remove(search.box.id);
            for (const node of nodes) {
                if (node !== search.box) node.destroyRecursively();
            }
            nodes = timelineNodes(renderer, state, search, view.pointer);
            for (const node of nodes) {
                box.add(node);
            }
        },
    };
    return view;
}

export function updateTuiTimelineSearch(
    state: TuiTimelinePickerState,
    query: string,
    cursor = query.length,
): TuiTimelinePickerTransition {
    return state.screen !== "select"
        ? unchanged(state, false)
        : changed({
            ...state,
            query,
            queryCursor: cursor,
            selectedIndex: query === state.query ? state.selectedIndex : 0,
            notice: undefined,
        });
}

function timelineNodes(
    renderer: RenderContext,
    state: TuiTimelinePickerState,
    search: ReturnType<typeof createDialogSearchNode>,
    pointer?: DialogRowPointer,
): Renderable[] {
    const nodes: Renderable[] = [
        dialogHeaderNode(renderer, timelineTitle(state)),
    ];
    const pushNotice = (notice: string | undefined): void => {
        if (notice !== undefined) {
            nodes.push(noticeText(renderer, notice));
        }
    };

    if (state.screen === "loading") {
        pushNotice(state.notice);
        nodes.push(bodyText(renderer, "Loading conversation timeline…"));
        nodes.push(dialogFooterNode(renderer, "esc close"));
        return nodes;
    }

    const selected = selectedBoundary(state);
    if (state.screen === "select") {
        updateDialogSearchNode(
            search,
            state.query,
            "Search",
            true,
            state.queryCursor,
        );
        nodes.push(search.box);
        pushNotice(state.notice);
        const filtered = filteredBoundaries(state);
        if (filtered.length === 0) {
            nodes.push(bodyText(renderer, "No matching user messages."));
        } else {
            const selectedIndex = clampedIndex(state, filtered);
            const visibleRows = Math.max(1, Math.min(6,
                renderer.height - dialogInsetTop(renderer) - dialogInsetBottomOffset(renderer) - 16 + DIALOG_SEARCH_HEIGHT - dialogSearchHeight(renderer),
            ));
            const visibleStart = Math.max(
                0,
                Math.min(selectedIndex - 2, Math.max(0, filtered.length - visibleRows)),
            );
            filtered.slice(visibleStart, visibleStart + visibleRows).forEach(
                (boundary, index) => {
                    nodes.push(dialogOptionRow(renderer, {
                        label: oneLine(boundary.prompt),
                        leading: `${boundaryTime(boundary.timestamp)}  `,
                        active: index + visibleStart === selectedIndex,
                        ...dialogRowPointer(pointer, index + visibleStart),
                    }));
                },
            );
        }
        const description = bodyText(
            renderer,
            selected === undefined
                ? "No conversation boundary selected."
                : `Rewind to before: “${truncate(oneLine(selected.prompt), 72)}”\n`
                    + "Workspace files and external effects will not change.",
        );
        if (renderer.height < 30) description.marginTop = 0;
        nodes.push(description);
        nodes.push(dialogFooterNode(
            renderer,
            "↑↓ move · type to search · ⏎ actions · esc close",
        ));
        return nodes;
    }

    if (selected === undefined) {
        nodes.push(bodyText(renderer, "No conversation boundary selected."));
        nodes.push(dialogFooterNode(renderer, "esc back"));
        return nodes;
    }
    const selectedText = `To before: “${truncate(oneLine(selected.prompt), 72)}”`;

    if (state.screen === "actions") {
        nodes.push(bodyText(renderer, selectedText));
        pushNotice(state.notice);
        nodes.push(dialogOptionRow(renderer, {
            label: "Rewind conversation",
            active: state.selectedAction === "rewind",
            ...dialogRowPointer(pointer, 0),
        }));
        nodes.push(dialogOptionRow(renderer, {
            label: "Cancel",
            active: state.selectedAction === "cancel",
            ...dialogRowPointer(pointer, 1),
        }));
        nodes.push(dialogFooterNode(renderer, "↑↓ move · ⏎ select · esc back"));
        return nodes;
    }

    if (state.screen === "previewing") {
        nodes.push(bodyText(
            renderer,
            `${selectedText}\n\nPreparing conversation preview…`,
        ));
        return nodes;
    }

    const plan = state.plan;
    pushNotice(state.notice);
    nodes.push(bodyText(
        renderer,
        `To before: “${truncate(oneLine(plan.boundary.prompt), 72)}”\n\n`
            + `Conversation  keep ${plan.keptMessageCount} messages; set aside `
            + `${plan.setAsideMessageCount} later messages\n`
            + "Files         unchanged\n"
            + "External work unchanged",
    ));
    if (state.screen === "applying") {
        nodes.push(bodyText(renderer, "Rewinding conversation…"));
        return nodes;
    }
    nodes.push(dialogFooterNode(renderer, "⏎ rewind · esc back"));
    return nodes;
}

function bodyText(renderer: RenderContext, content: string): TextRenderable {
    return new TextRenderable(renderer, {
        content,
        fg: TUI_TEXT,
        width: "100%",
        height: "auto",
        wrapMode: "word",
        marginTop: 1,
        paddingLeft: 1,
        paddingRight: 1,
    });
}

function noticeText(renderer: RenderContext, content: string): TextRenderable {
    return new TextRenderable(renderer, {
        content,
        fg: TUI_NOTICE,
        width: "100%",
        height: "auto",
        wrapMode: "word",
        marginTop: 1,
        paddingLeft: 1,
        paddingRight: 1,
    });
}

function handleSelectKey(
    state: TimelinePickerSelectState,
    key: Pick<KeyEvent, "name" | "sequence">,
): TuiTimelinePickerTransition {
    const filtered = filteredBoundaries(state);
    if (key.name === "up" || key.name === "down") {
        const delta = key.name === "up" ? -1 : 1;
        const selectedIndex = Math.min(
            Math.max(0, filtered.length - 1),
            Math.max(0, clampedIndex(state, filtered) + delta),
        );
        return changed({ ...state, selectedIndex, notice: undefined });
    }
    if (key.name === "tab") {
        return unchanged(state);
    }
    if (key.name === "return" || key.name === "kpenter") {
        if (filtered.length === 0) {
            return unchanged(state);
        }
        if (state.operation === "fork") {
            return {
                forkBoundaryId: filtered[clampedIndex(state, filtered)]!
                    .userMessageId,
                handled: true,
            };
        }
        return changed({
                ...state,
                screen: "actions",
                selectedIndex: clampedIndex(state, filtered),
                selectedAction: "rewind",
                notice: undefined,
            });
    }
    return unchanged(state, false);
}

function handleActionsKey(
    state: TimelinePickerActionsState,
    key: Pick<KeyEvent, "name" | "sequence">,
    createRequestId: () => string,
): TuiTimelinePickerTransition {
    if (key.name === "up" || key.name === "down") {
        return changed({
            ...state,
            selectedAction: key.name === "up" ? "rewind" : "cancel",
            notice: undefined,
        });
    }
    if (key.sequence === "1" || key.name === "1") {
        return previewTransition(state, createRequestId);
    }
    if (key.sequence === "2" || key.name === "2") {
        return { handled: true };
    }
    if (key.name === "return" || key.name === "kpenter") {
        return state.selectedAction === "cancel"
            ? { handled: true }
            : previewTransition(state, createRequestId);
    }
    return unchanged(state, false);
}

function handleConfirmKey(
    state: TimelinePickerConfirmState,
    key: Pick<KeyEvent, "name" | "sequence">,
    createRequestId: () => string,
): TuiTimelinePickerTransition {
    const apply = key.sequence === "1"
        || key.name === "1"
        || key.name === "return"
        || key.name === "kpenter";
    if (!apply) {
        return unchanged(state, false);
    }
    const requestId = createRequestId();
    return {
        state: { ...baseState(state), screen: "applying", requestId, plan: state.plan },
        command: {
            type: "apply_timeline_action",
            requestId,
            planId: state.plan.planId,
        },
        handled: true,
    };
}

function previewTransition(
    state: TimelinePickerActionsState,
    createRequestId: () => string,
): TuiTimelinePickerTransition {
    const boundary = selectedBoundary(state);
    if (boundary === undefined) {
        return unchanged(state);
    }
    if (boundary.attachments !== undefined && boundary.attachments.length > 0) {
        return {
            state: {
                ...state,
                notice: "Image prompts cannot be restored until the attachment composer is available.",
            },
            handled: true,
        };
    }
    const requestId = createRequestId();
    return {
        state: { ...baseState(state), screen: "previewing", requestId },
        command: {
            type: "preview_timeline_action",
            requestId,
            boundaryId: boundary.userMessageId,
            action: "rewind_conversation",
        },
        handled: true,
    };
}

function escapeTimelineScreen(
    state: TuiTimelinePickerState,
): TuiTimelinePickerTransition {
    if (state.screen === "applying") {
        return unchanged(state);
    }
    if (state.screen === "loading" || state.screen === "select") {
        return { handled: true };
    }
    if (state.screen === "actions" || state.screen === "previewing") {
        return changed({ ...baseState(state), screen: "select" });
    }
    return changed({
        ...baseState(state),
        screen: "actions",
        selectedAction: "rewind",
    });
}

function filteredBoundaries(
    state: TimelinePickerBase,
): readonly TimelineBoundary[] {
    const query = state.query.trim().toLocaleLowerCase();
    if (query.length === 0) {
        return state.boundaries;
    }
    return state.boundaries.filter((boundary) =>
        boundary.prompt.toLocaleLowerCase().includes(query)
        || boundary.timestamp.toLocaleLowerCase().includes(query)
    );
}

function selectedBoundary(
    state: TimelinePickerBase,
): TimelineBoundary | undefined {
    const filtered = filteredBoundaries(state);
    return filtered[clampedIndex(state, filtered)];
}

function clampedIndex(
    state: TimelinePickerBase,
    boundaries: readonly TimelineBoundary[],
): number {
    return Math.min(state.selectedIndex, Math.max(0, boundaries.length - 1));
}

function baseState(state: TimelinePickerBase): TimelinePickerBase {
    return {
        ...(state.operation === undefined
            ? {}
            : { operation: state.operation }),
        boundaries: state.boundaries,
        query: state.query,
        ...(state.queryCursor === undefined
            ? {}
            : { queryCursor: state.queryCursor }),
        selectedIndex: state.selectedIndex,
    };
}

function changed(state: TuiTimelinePickerState): TuiTimelinePickerTransition {
    return { state, handled: true };
}

function unchanged(
    state: TuiTimelinePickerState,
    handled = true,
): TuiTimelinePickerTransition {
    return { state, handled };
}

function hasCommandModifier(
    key: Pick<KeyEvent, "ctrl" | "meta" | "super" | "hyper">,
): boolean {
    return key.ctrl === true
        || key.meta === true
        || key.super === true
        || key.hyper === true;
}

function rejectionNotice(reason: string): string {
    if (reason === "busy") {
        return "Rewind is available when the agent is idle.";
    }
    if (reason === "session_changed" || reason === "plan_expired") {
        return "The conversation changed. Refreshing the timeline.";
    }
    if (reason === "not_plan_owner") {
        return "This preview belongs to another attached client.";
    }
    if (reason === "boundary_missing") {
        return "That conversation point is no longer available. Refreshing the timeline.";
    }
    return "Rewind is temporarily unavailable.";
}

function requiresRefresh(reason: string): boolean {
    return reason === "session_changed"
        || reason === "plan_expired"
        || reason === "boundary_missing";
}

function refreshTimeline(
    reason: string,
    createRequestId: () => string,
): TuiTimelinePickerTransition {
    const requestId = createRequestId();
    return {
        state: {
            screen: "loading",
            requestId,
            notice: rejectionNotice(reason),
        },
        command: { type: "list_timeline", requestId },
        handled: true,
    };
}

function timelineTitle(state: TuiTimelinePickerState): string {
    if (state.operation === "fork") {
        return state.screen === "loading" ? "Loading prompts" : "Fork session";
    }
    if (state.screen === "select" || state.screen === "loading") {
        return "Rewind: select a point";
    }
    if (state.screen === "confirm" || state.screen === "applying") {
        return "Confirm rewind";
    }
    return "Rewind: choose an action";
}

function boundaryTime(timestamp: string): string {
    return timestamp.length >= 16 ? timestamp.slice(11, 16) : timestamp;
}

function oneLine(text: string): string {
    return text.replaceAll(/\s+/g, " ").trim();
}

function truncate(text: string, limit: number): string {
    return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}
