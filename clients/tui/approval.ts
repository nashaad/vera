import {
    BoxRenderable,
    fg,
    ScrollBoxRenderable,
    StyledText,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import type {
    AgentUpdate,
    ToolApprovalUiRequestUpdate,
    UiResponseCommand,
} from "../../src/engine/protocol.ts";
import { isToolApprovalUiRequestUpdate } from "../../src/engine/protocol.ts";
import {
    TUI_BACKGROUND,
    TUI_MUTED,
    TUI_NOTICE,
    TUI_PANEL,
    TUI_TEXT,
} from "./state.ts";
import {
    attachDialogRowPointer,
    dialogBottomOffset,
    type DialogRowPointer,
} from "./dialog-chrome.ts";

/**
 * The prompt takes the composer's slot at the bottom of the screen: a
 * notice-toned bar down the left edge, a "Permission required" header with the
 * reason, the exact call and its grant predicates in the body, and one row of
 * buttons. The buttons keep their digits, so the keys that always answered the
 * prompt still do; ←/→ and ⏎ select the same answers by highlight.
 */
const APPROVAL_ROWS = [
    { key: "1", label: "Allow once" },
    { key: "2", label: "Allow session" },
    { key: "3", label: "Deny" },
    { key: "4", label: "Allow always" },
] as const;

/**
 * Rows 2 and 4 derive the same predicate and differ only in where it is stored,
 * so they carry matching labels: a durable row that silenced a different set of
 * future prompts than the session row above it would be unpredictable from the
 * label alone.
 *
 * The durable row is `4` and deny stays on `3`, out of escalating order on
 * purpose. Renumbering deny would retrain an existing keypress toward the more
 * permissive direction, and a mis-hit there grants a permission that outlives
 * the session.
 */
export type TuiApprovalDecision =
    | "allow_once"
    | "allow_similar"
    | "allow_always"
    | "deny";

export interface TuiApprovalKey {
    readonly name: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
}

export interface TuiApprovalKeyResult {
    readonly handled: boolean;
    readonly response?: UiResponseCommand;
}

export interface TuiApprovalView {
    readonly box: BoxRenderable;
    // Buttons carry their own digit, so a click sends the digit the keyboard
    // would have sent rather than a second decision path.
    pointer?: DialogRowPointer;
    readonly bar: BoxRenderable;
    readonly headerText: TextRenderable;
    readonly details: ScrollBoxRenderable;
    readonly detailsText: TextRenderable;
    readonly actions: BoxRenderable;
    focus(): void;
    update(update: ToolApprovalUiRequestUpdate): void;
    handleKey(
        update: ToolApprovalUiRequestUpdate,
        key: TuiApprovalKey,
    ): TuiApprovalKeyResult;
    repaint(): void;
}

export function createTuiApprovalView(
    renderer: RenderContext,
): TuiApprovalView {
    let currentRequestId: string | undefined;
    let lastUpdate: ToolApprovalUiRequestUpdate | undefined;
    // Highlighted button for ←/→ and ⏎. Client-local: the engine only ever
    // sees the decision.
    let selectedKey: string = "1";

    const bar = new BoxRenderable(renderer, {
        id: "approval-bar",
        width: 1,
        backgroundColor: TUI_NOTICE,
        flexShrink: 0,
    });
    const headerText = new TextRenderable(renderer, {
        id: "approval-header-text",
        content: "",
        width: "100%",
        height: "auto",
        wrapMode: "word",
    });
    const detailsText = new TextRenderable(renderer, {
        id: "approval-details-text",
        content: "",
        fg: TUI_TEXT,
        width: "100%",
        height: "auto",
        wrapMode: "word",
        selectable: true,
    });
    const details = new ScrollBoxRenderable(renderer, {
        id: "approval-details",
        width: "100%",
        flexGrow: 1,
        minHeight: 1,
        marginTop: 1,
        scrollY: true,
        scrollX: false,
        viewportCulling: true,
        contentOptions: {
            flexDirection: "column",
        },
    });
    details.add(detailsText);

    // Narrow terminals wrap the buttons onto further rows rather than clipping
    // an answer off the screen.
    const buttons = new BoxRenderable(renderer, {
        id: "approval-buttons",
        height: "auto",
        flexDirection: "row",
        flexWrap: "wrap",
        flexGrow: 1,
        flexShrink: 1,
    });
    const hints = new TextRenderable(renderer, {
        id: "approval-hints",
        content: "",
        height: 1,
        flexShrink: 1,
        overflow: "hidden",
        wrapMode: "none",
    });
    const actions = new BoxRenderable(renderer, {
        id: "approval-actions",
        width: "100%",
        height: "auto",
        marginTop: 1,
        flexShrink: 0,
        flexDirection: "row",
        justifyContent: "space-between",
    });
    actions.add(buttons);
    actions.add(hints);

    const content = new BoxRenderable(renderer, {
        id: "approval-content",
        flexGrow: 1,
        flexDirection: "column",
        gap: 0,
        paddingTop: 1,
        paddingLeft: 2,
        paddingRight: 2,
    });
    content.add(headerText);
    content.add(details);
    content.add(actions);

    const box = new BoxRenderable(renderer, {
        id: "approval-box",
        border: false,
        backgroundColor: TUI_PANEL,
        position: "absolute",
        bottom: dialogBottomOffset(renderer),
        left: 0,
        width: "100%",
        height: "auto",
        maxHeight: "90%",
        zIndex: 20,
        flexDirection: "row",
        visible: false,
    });
    box.add(bar);
    box.add(content);

    let buttonNodes: TextRenderable[] = [];

    function renderButtons(update: ToolApprovalUiRequestUpdate): void {
        for (const node of buttonNodes) {
            node.destroy();
        }
        buttonNodes = [];
        const available = selectableApprovalKeys(update);
        for (const action of visibleApprovalRows(update)) {
            const active = action.key === selectedKey;
            const node = new TextRenderable(renderer, {
                content: new StyledText([
                    fg(active ? TUI_BACKGROUND : TUI_MUTED)(
                        ` ${action.key} ${action.label} `,
                    ),
                ]),
                bg: active ? TUI_NOTICE : TUI_PANEL,
                attributes: active ? 1 : 0,
                height: 1,
                flexShrink: 0,
                marginRight: 2,
            });
            if (available.includes(action.key)) {
                attachDialogRowPointer(node, view.pointer, Number(action.key));
            }
            buttons.add(node);
            buttonNodes.push(node);
        }
    }

    function renderChrome(update: ToolApprovalUiRequestUpdate): void {
        bar.backgroundColor = TUI_NOTICE;
        box.backgroundColor = TUI_PANEL;
        detailsText.fg = TUI_TEXT;
        headerText.content = new StyledText([
            fg(TUI_NOTICE)("△ Permission required\n"),
            fg(TUI_TEXT)(`← ${friendlyReason(update.request.reason)}`),
        ]);
        hints.content = new StyledText([
            fg(TUI_TEXT)("←→"),
            fg(TUI_MUTED)(" select  "),
            fg(TUI_TEXT)("enter"),
            fg(TUI_MUTED)(" confirm  "),
            fg(TUI_TEXT)("esc"),
            fg(TUI_MUTED)(" deny"),
        ]);
        // Narrow terminals give the hints' columns to the buttons: the keys
        // still work unlabelled, an answer pushed off the screen does not.
        hints.visible = renderer.width >= 60;
        renderButtons(update);
    }

    const view: TuiApprovalView = {
        box,
        bar,
        headerText,
        details,
        detailsText,
        actions,
        focus(): void {
            details.focus();
        },
        update(update): void {
            lastUpdate = update;
            box.bottom = dialogBottomOffset(renderer);
            hints.visible = renderer.width >= 60;
            if (currentRequestId === update.requestId) {
                return;
            }
            currentRequestId = update.requestId;
            selectedKey = "1";
            detailsText.content = renderTuiApprovalDetails(update);
            renderChrome(update);
            details.scrollTo(0);
        },
        handleKey(update, key): TuiApprovalKeyResult {
            if (key.ctrl || key.meta || key.shift) {
                return { handled: false };
            }
            if (key.name === "left" || key.name === "right") {
                const keys = selectableApprovalKeys(update);
                const index = Math.max(0, keys.indexOf(selectedKey));
                const next = key.name === "left"
                    ? Math.max(0, index - 1)
                    : Math.min(keys.length - 1, index + 1);
                if (keys[next] !== undefined && keys[next] !== selectedKey) {
                    selectedKey = keys[next];
                    renderButtons(update);
                }
                return { handled: true };
            }
            if (key.name === "return" || key.name === "enter") {
                const response = createTuiApprovalResponse(update, {
                    name: selectedKey,
                });
                return response === undefined
                    ? { handled: true }
                    : { handled: true, response };
            }
            const response = createTuiApprovalResponse(update, key);
            return response === undefined
                ? { handled: false }
                : { handled: true, response };
        },
        repaint(): void {
            if (lastUpdate === undefined) {
                return;
            }
            renderChrome(lastUpdate);
        },
    };
    return view;
}

export function renderTuiApproval(update: ToolApprovalUiRequestUpdate): string {
    return [
        "Permission required",
        `← ${friendlyReason(update.request.reason)}`,
        "",
        renderTuiApprovalDetails(update),
        "",
        visibleApprovalRows(update)
            .map((action) => `${action.key} ${action.label}`)
            .join("  ·  "),
    ].join("\n");
}

export function renderTuiApprovalDetails(
    update: ToolApprovalUiRequestUpdate,
): string {
    return [
        ...(update.request.sourceAgentId === undefined
            ? []
            : [
                `Requested by agent ${shortAgentId(update.request.sourceAgentId)}`,
                ...(update.request.sourceTask === undefined
                    ? []
                    : [`Task: ${update.request.sourceTask}`]),
                "",
            ]),
        formatToolCall(update),
        "",
        update.request.warning,
        ...grantsSection(update),
    ].join("\n");
}

export function tuiApprovalDecision(
    key: TuiApprovalKey,
    grantsAvailable = true,
): TuiApprovalDecision | undefined {
    if (key.ctrl || key.meta || key.shift) {
        return undefined;
    }
    if (key.name === "1") {
        return "allow_once";
    }
    if (key.name === "2" && grantsAvailable) {
        return "allow_similar";
    }
    if (key.name === "3" || key.name === "escape") {
        return "deny";
    }
    if (key.name === "4" && grantsAvailable) {
        return "allow_always";
    }
    return undefined;
}

export function createTuiApprovalResponse(
    update: ToolApprovalUiRequestUpdate,
    key: TuiApprovalKey,
): UiResponseCommand | undefined {
    const decision = tuiApprovalDecision(
        key,
        update.request.permissionGrants !== undefined
            && update.request.sourceAgentId === undefined,
    );
    if (decision === undefined) {
        return undefined;
    }
    return {
        type: "ui_response",
        requestId: update.requestId,
        response: { type: "tool_approval", decision },
    };
}

export function applyTuiApprovalUpdate(
    current: ToolApprovalUiRequestUpdate | undefined,
    update: AgentUpdate,
): ToolApprovalUiRequestUpdate | undefined {
    if (
        update.type === "ui_request"
        && isToolApprovalUiRequestUpdate(update)
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

/** Rows whose meaning comes from the derived grant predicate, not the tool. */
function isDerivedRow(key: string): boolean {
    return key === "2" || key === "4";
}

/** The digits ←/→ and a click can land on: derived rows need a predicate. */
export function selectableApprovalKeys(
    update: ToolApprovalUiRequestUpdate,
): readonly string[] {
    return visibleApprovalRows(update)
        .filter((action) =>
            !isDerivedRow(action.key)
            || update.request.permissionGrants !== undefined
        )
        .map((action) => action.key);
}

function formatToolCall(update: ToolApprovalUiRequestUpdate): string {
    const command = update.request.toolCall.input.command;
    if (update.request.toolCall.name === "bash" && typeof command === "string") {
        return `$ ${command}`;
    }
    return `${update.request.toolCall.name} ${JSON.stringify(update.request.toolCall.input)}`;
}

/**
 * What "Allow session" and "Allow always" would remember, as body lines. When
 * no predicate can be derived the buttons stay rendered so the digits do not
 * shift, and this section is where their unavailability is stated.
 */
function grantsSection(update: ToolApprovalUiRequestUpdate): string[] {
    if (update.request.sourceAgentId !== undefined) {
        return [];
    }
    const grants = update.request.permissionGrants;
    if (grants === undefined) {
        return ["", "Allow session / always", "- not available for this command"];
    }
    return ["", "Allow session / always", ...grants.map((grant) => `- ${describeGrant(grant)}`)];
}

export function tuiApprovalHint(
    update: ToolApprovalUiRequestUpdate,
): string {
    return update.request.sourceAgentId === undefined
        ? "approval required · 1 once · 2 session prefix · 3/esc deny · ctrl+c stop"
        : "approval required · 1 once · 3/esc deny · ctrl+c stop";
}

function visibleApprovalRows(
    update: ToolApprovalUiRequestUpdate,
): readonly (typeof APPROVAL_ROWS)[number][] {
    return update.request.sourceAgentId === undefined
        ? APPROVAL_ROWS
        : APPROVAL_ROWS.filter((action) => !isDerivedRow(action.key));
}

function describeGrant(
    grant: NonNullable<
        ToolApprovalUiRequestUpdate["request"]["permissionGrants"]
    >[number],
): string {
    const when = grant.when;
    if (when.path !== undefined) {
        return `${when.verb ?? "access"} under ${when.path}`;
    }
    if (when.executable !== undefined) {
        return `future ${when.executable} commands`;
    }
    if (when.operation !== undefined) {
        return `future ${when.operation} operations`;
    }
    return `future ${when.tool ?? "similar"} actions`;
}

function friendlyReason(reason: string): string {
    return reason.startsWith("Permission mode ")
        ? "Vera needs your approval before running this command."
        : reason;
}

function shortAgentId(id: string): string {
    return id.slice(0, 8);
}
