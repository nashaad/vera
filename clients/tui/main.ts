import {
    BoxRenderable,
    CliRenderEvents,
    MarkdownRenderable,
    ScrollBoxRenderable,
    SyntaxStyle,
    TextRenderable,
    createCliRenderer,
    type Selection,
} from "@opentui/core";
import { randomUUID } from "node:crypto";

import type {
    AgentUpdate,
    ClientCommand,
    UiRequestUpdate,
} from "../../src/engine/protocol.ts";
import {
    createAgentThroughHost,
    resumeAgentThroughHost,
} from "../../src/host/agent-start-client.ts";
import { attachAgent } from "../../src/host/attached-client.ts";
import { findOrStartResidentHost } from "../host/launch.ts";
import {
    applyTuiApprovalUpdate,
    createTuiApprovalResponse,
    renderTuiApproval,
} from "./approval.ts";
import { copyTuiText, countTuiCharacters } from "./clipboard.ts";
import { createTuiComposer } from "./composer.ts";
import { tuiInterruptAction } from "./interrupt.ts";
import { isTranscriptSelection } from "./selection.ts";
import { renderTuiStatusLine } from "./status.ts";
import {
    TUI_ACCENT,
    TUI_MUTED,
    TUI_NOTICE,
    TUI_TEXT,
    appendTuiNotice,
    applyAgentUpdate,
    beginNextQueuedTuiTurn,
    beginTuiTurn,
    createTuiState,
    queueTuiPrompt,
    renderTuiEntry,
    renderTuiQueuedPrompt,
    tuiEntryMarginTop,
} from "./state.ts";

const READY_HINT = "enter send · shift+enter newline · ctrl+c quit";
const WORKING_HINT = "working… · enter queue · esc redirect/stop · ctrl+c stop";
const STOPPING_HINT = "stopping…";
const APPROVAL_HINT = "approval required · y allow · n/esc deny · ctrl+c stop";
const COPY_NOTICE_DURATION_MS = 1_500;

export interface TuiDependencies {
    readonly client: TuiAgentClient;
}

export interface TuiAgentClient {
    send(command: ClientCommand): Promise<void>;
    receive(signal?: AbortSignal): Promise<AgentUpdate>;
    detach(): Promise<void>;
    close(): void;
}

export interface CreateTuiTarget {
    readonly type: "create";
    readonly workspace: string;
}

export interface AttachTuiTarget {
    readonly type: "attach";
    readonly agentId: string;
}

export interface ResumeTuiTarget {
    readonly type: "resume";
    readonly sessionPath: string;
}

export type TuiStartTarget =
    | CreateTuiTarget
    | AttachTuiTarget
    | ResumeTuiTarget;

if (import.meta.main) {
    await startConfiguredTui({
        type: "create",
        workspace: process.cwd(),
    });
}

export async function startConfiguredTui(target: TuiStartTarget): Promise<void> {
    const host = await findOrStartResidentHost();
    const agentId = target.type === "create"
        ? (await createAgentThroughHost(
            host.socket_path,
            target.workspace,
        )).id
        : target.type === "resume"
            ? (await resumeAgentThroughHost(
                host.socket_path,
                target.sessionPath,
            )).id
            : target.agentId;
    const client = await attachAgent({
        socketPath: host.socket_path,
        agentId,
    });
    try {
        await startTui({ client });
    } catch (error) {
        client.close();
        throw error;
    }
}

export async function startTui(
    dependencies: TuiDependencies,
): Promise<void> {
    const { client } = dependencies;
    const renderer = await createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 30,
    });
    renderer.setTerminalTitle("Vera");

    let state = createTuiState();
    let statusNotice: string | undefined;
    let statusNoticeVersion = 0;
    let shuttingDown = false;
    let abortRequested = false;
    let pendingApproval: UiRequestUpdate | undefined;

    const markdownStyle = SyntaxStyle.fromStyles({
        default: { fg: TUI_TEXT },
        "markup.heading": { fg: TUI_ACCENT, bold: true },
        "markup.strong": { bold: true },
        "markup.italic": { italic: true },
        "markup.raw": { fg: "#9ECE6A" },
        "markup.raw.block": { fg: "#9ECE6A" },
        "markup.list": { fg: TUI_ACCENT },
        "markup.quote": { fg: TUI_MUTED, italic: true },
        "markup.link": { fg: TUI_ACCENT, underline: true },
        "markup.link.label": { fg: TUI_ACCENT },
        "markup.link.url": { fg: TUI_MUTED, underline: true },
        conceal: { fg: TUI_MUTED },
    });

    const transcript = new ScrollBoxRenderable(renderer, {
        id: "transcript",
        flexGrow: 1,
        width: "100%",
        stickyScroll: true,
        stickyStart: "bottom",
        scrollY: true,
        contentOptions: {
            flexDirection: "column",
            gap: 0,
            paddingTop: 1,
            paddingBottom: 1,
            paddingLeft: 2,
            paddingRight: 2,
        },
    });

    const placeholder = new TextRenderable(renderer, {
        id: "placeholder",
        content: "Start a conversation with Vera.",
        fg: TUI_MUTED,
        width: "100%",
    });
    transcript.add(placeholder);

    const entryNodes: (TextRenderable | MarkdownRenderable)[] = [];

    const statusText = new TextRenderable(renderer, {
        id: "status",
        content: READY_HINT,
        fg: "#565B66",
        width: "100%",
        height: 1,
        paddingLeft: 2,
    });

    const queuedPromptText = new TextRenderable(renderer, {
        id: "queued-prompt",
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        paddingLeft: 2,
        visible: false,
    });

    const composer = createTuiComposer(renderer, submitPrompt);

    const approvalText = new TextRenderable(renderer, {
        id: "approval-text",
        content: "",
        fg: TUI_TEXT,
        width: "100%",
        height: "auto",
        wrapMode: "word",
        selectable: true,
    });

    const approvalBox = new BoxRenderable(renderer, {
        id: "approval-box",
        title: " Tool approval ",
        border: true,
        borderColor: TUI_NOTICE,
        width: "100%",
        height: "auto",
        paddingX: 1,
        visible: false,
    });
    approvalBox.add(approvalText);

    const composerBox = new BoxRenderable(renderer, {
        id: "composer-box",
        border: ["left"],
        borderStyle: "heavy",
        borderColor: "#7AA2F7",
        backgroundColor: "#16161E",
        width: "100%",
        height: 3,
        paddingX: 1,
    });
    composerBox.add(composer);

    const app = new BoxRenderable(renderer, {
        id: "app",
        width: "100%",
        height: "100%",
        flexDirection: "column",
        gap: 1,
        paddingTop: 1,
        paddingBottom: 0,
    });
    app.add(transcript);
    app.add(queuedPromptText);
    app.add(approvalBox);
    app.add(composerBox);
    app.add(statusText);
    renderer.root.add(app);
    composer.focus();
    renderStatus();

    renderer.on(CliRenderEvents.DESTROY, () => {
        shuttingDown = true;
        void client.detach().catch(() => client.close());
    });

    renderer.on(CliRenderEvents.SELECTION, (selection: Selection) => {
        if (isTranscriptSelection(selection, entryNodes)) {
            void copyTranscriptSelection(selection);
        }
    });

    renderer.keyInput.on("keypress", (key) => {
        if (pendingApproval !== undefined) {
            const response = createTuiApprovalResponse(pendingApproval, key);
            if (response !== undefined) {
                key.preventDefault();
                key.stopPropagation();
                sendCommand(response);
                pendingApproval = undefined;
                composer.focus();
                renderState();
                return;
            }
        }

        const action = tuiInterruptAction(key, state.working, abortRequested);
        if (action === "pass") {
            return;
        }

        key.preventDefault();
        key.stopPropagation();

        if (action === "quit") {
            renderer.destroy();
            return;
        }
        if (action === "abort") {
            abortRequested = true;
            sendCommand({ type: "abort" });
            renderStatus();
        }
    });

    void receiveAgentUpdates();
    sendCommand({
        type: "get_model_settings",
        requestId: randomUUID(),
    });
    sendCommand({
        type: "get_permissions",
        requestId: randomUUID(),
    });

    function submitPrompt(): void {
        const prompt = composer.expandedText().trim();
        if (prompt.length === 0) {
            return;
        }

        composer.clearComposer();
        state = state.working
            ? queueTuiPrompt(state, prompt)
            : beginTuiTurn(state, prompt);
        renderState();
        sendCommand({ type: "prompt", content: prompt });
    }

    async function receiveAgentUpdates(): Promise<void> {
        try {
            while (!shuttingDown) {
                const update = await client.receive();
                if (shuttingDown) {
                    return;
                }
                if (
                    update.type === "ui_request"
                    || update.type === "ui_request_closed"
                ) {
                    const previousApproval = pendingApproval;
                    pendingApproval = applyTuiApprovalUpdate(
                        pendingApproval,
                        update,
                    );
                    if (pendingApproval !== undefined) {
                        composer.blur();
                    } else if (previousApproval !== undefined) {
                        composer.focus();
                    }
                    if (pendingApproval !== previousApproval) {
                        renderState();
                    }
                    continue;
                }
                state = applyAgentUpdate(state, update);
                if (update.type === "turn_finished") {
                    abortRequested = false;
                    finishStreamingAssistant();
                    state = beginNextQueuedTuiTurn(state);
                }
                renderState();

                if (!state.working) {
                    composer.focus();
                }
            }
        } catch (error) {
            reportConnectionError(error);
        }
    }

    function sendCommand(command: ClientCommand): void {
        void client.send(command).catch(reportConnectionError);
    }

    function reportConnectionError(error: unknown): void {
        if (shuttingDown) {
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        pendingApproval = undefined;
        state = appendTuiNotice(state, `Connection error: ${message}`);
        renderState();
    }

    function renderState(): void {
        if (shuttingDown) {
            return;
        }

        placeholder.visible = state.entries.length === 0;
        queuedPromptText.content = renderTuiQueuedPrompt(state);
        queuedPromptText.visible = state.queuedPrompts.length > 0;
        approvalBox.visible = pendingApproval !== undefined;
        composerBox.visible = pendingApproval === undefined;
        if (pendingApproval !== undefined) {
            approvalText.content = renderTuiApproval(pendingApproval);
        }

        state.entries.forEach((entry, index) => {
            const existing = entryNodes[index];
            if (existing) {
                if (
                    existing instanceof MarkdownRenderable &&
                    existing.content !== entry.text
                ) {
                    existing.content = entry.text;
                }
                return;
            }

            const marginTop = tuiEntryMarginTop(state.entries, index);
            const node = entry.kind === "assistant"
                ? new MarkdownRenderable(renderer, {
                    id: `entry-${index}`,
                    content: entry.text,
                    syntaxStyle: markdownStyle,
                    fg: TUI_TEXT,
                    streaming: true,
                    width: "100%",
                    marginTop,
                })
                : new TextRenderable(renderer, {
                    id: `entry-${index}`,
                    content: renderTuiEntry(entry),
                    width: "100%",
                    wrapMode: "word",
                    selectable: true,
                    marginTop,
                });
            entryNodes.push(node);
            transcript.add(node);
        });

        renderStatus();
    }

    function finishStreamingAssistant(): void {
        for (let index = entryNodes.length - 1; index >= 0; index -= 1) {
            const node = entryNodes[index];
            if (node instanceof MarkdownRenderable) {
                node.streaming = false;
                return;
            }
        }
    }

    async function copyTranscriptSelection(selection: Selection): Promise<void> {
        const text = selection.getSelectedText();
        if (text.length === 0) {
            return;
        }

        try {
            await copyTuiText(text, renderer);
            if (shuttingDown) {
                return;
            }
            if (renderer.getSelection() === selection) {
                renderer.clearSelection();
            }
            const count = countTuiCharacters(text);
            showStatusNotice(`copied ${count} character${count === 1 ? "" : "s"}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            showStatusNotice(`copy failed · ${message}`);
        }
    }

    function showStatusNotice(message: string): void {
        statusNotice = message;
        statusNoticeVersion += 1;
        const version = statusNoticeVersion;
        renderStatus();

        setTimeout(() => {
            if (statusNoticeVersion !== version) {
                return;
            }
            statusNotice = undefined;
            renderStatus();
        }, COPY_NOTICE_DURATION_MS);
    }

    function renderStatus(): void {
        if (shuttingDown) {
            return;
        }

        let lifecycleHint = READY_HINT;
        if (abortRequested) {
            lifecycleHint = STOPPING_HINT;
        } else if (pendingApproval !== undefined) {
            lifecycleHint = APPROVAL_HINT;
        } else if (state.working) {
            lifecycleHint = WORKING_HINT;
        }

        statusText.fg = statusNotice === undefined ? "#565B66" : TUI_NOTICE;
        statusText.content = renderTuiStatusLine(
            state.modelSettings,
            state.approvalMode,
            statusNotice ?? lifecycleHint,
        );
    }
}
