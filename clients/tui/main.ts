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

import {
    isToolApprovalUiRequestUpdate,
    isTimelineReplyUpdate,
    isUserQuestionUiRequestUpdate,
    type AgentUpdate,
    type ClientCommand,
    type UiRequestUpdate,
} from "../../src/engine/protocol.ts";
import type {
    TuiTimelinePickerState,
    TuiTimelinePickerTransition,
} from "./timeline-picker.ts";
import {
    createAgentThroughHost,
    resumeAgentThroughHost,
} from "../../src/host/agent-start-client.ts";
import { attachAgent } from "../../src/host/attached-client.ts";
import { findOrStartResidentHost } from "../host/launch.ts";
import {
    createTuiApprovalView,
    createTuiApprovalResponse,
} from "./approval.ts";
import {
    createTuiQuestionResponse,
    createTuiQuestionView,
} from "./question.ts";
import { copyTuiText, countTuiCharacters } from "./clipboard.ts";
import {
    createBuiltinTuiCommandRegistry,
    renderTuiCommandSuggestions,
} from "./commands.ts";
import { createTuiComposer } from "./composer.ts";
import { parseRawInputEvent, tuiInterruptAction } from "./interrupt.ts";
import { isTranscriptSelection } from "./selection.ts";
import { renderTuiStatusLine } from "./status.ts";
import {
    createTuiSettingsPickerView,
    handleTuiSettingsPickerKey,
    startTuiSettingsPicker,
    type TuiSettingsPickerState,
    type TuiSettingsPickerTransition,
} from "./settings-picker.ts";
import {
    applyTuiTimelineReply,
    createTuiTimelinePickerView,
    handleTuiTimelineKey,
    startTuiTimelinePicker,
} from "./timeline-picker.ts";
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
const WORKING_HINT = "enter queue · esc redirect/stop · ctrl+c stop";
const STOPPING_HINT = "stopping…";
const APPROVAL_HINT =
    "approval required · 1 once · 2 session prefix · 3/esc deny · ctrl+c stop";
const QUESTION_HINT = "question waiting · 1-9 choose · esc cancel · ctrl+c stop";
const COPY_NOTICE_DURATION_MS = 1_500;
const PROGRESS_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export interface TuiDependencies {
    readonly client: TuiAgentClient;
    readonly copyText?: (text: string) => Promise<void>;
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
    const copyText = dependencies.copyText
        ?? ((text: string) => copyTuiText(text, renderer));
    renderer.setTerminalTitle("Vera");

    let state = createTuiState();
    let statusNotice: string | undefined;
    let statusNoticeVersion = 0;
    let shuttingDown = false;
    let abortRequested = false;
    let pendingUiRequest: UiRequestUpdate | undefined;
    let timelinePicker: TuiTimelinePickerState | undefined;
    let settingsPicker: TuiSettingsPickerState | undefined;
    let commandSuggestionIndex = 0;
    let workingSince: number | undefined;
    let activity = "thinking";
    const commandRegistry = createBuiltinTuiCommandRegistry();

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
        position: "absolute",
        bottom: 0,
        zIndex: 30,
        bg: "#0F1016",
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
    const timelinePickerView = createTuiTimelinePickerView(renderer);
    const settingsPickerView = createTuiSettingsPickerView(renderer);
    const approvalView = createTuiApprovalView(renderer);
    const questionView = createTuiQuestionView(renderer);

    const commandSuggestionsText = new TextRenderable(renderer, {
        id: "command-suggestions-text",
        content: "",
        fg: TUI_TEXT,
        width: "100%",
        height: "auto",
    });
    const commandSuggestionsBox = new BoxRenderable(renderer, {
        id: "command-suggestions",
        title: " Commands ",
        border: true,
        borderColor: TUI_MUTED,
        width: "100%",
        height: 3,
        paddingX: 1,
        visible: false,
    });
    commandSuggestionsBox.add(commandSuggestionsText);
    composer.onContentChange = renderCommandSuggestions;

    const composerBox = new BoxRenderable(renderer, {
        id: "composer-box",
        border: ["left"],
        borderStyle: "heavy",
        borderColor: "#7AA2F7",
        backgroundColor: "#16161E",
        width: "100%",
        height: 3,
        paddingX: 1,
        marginBottom: 1,
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
    app.add(approvalView.box);
    app.add(questionView.box);
    app.add(timelinePickerView.box);
    app.add(settingsPickerView.box);
    app.add(commandSuggestionsBox);
    app.add(composerBox);
    app.add(statusText);
    renderer.root.add(app);
    composer.focus();
    renderStatus();

    renderer.on(CliRenderEvents.DESTROY, () => {
        shuttingDown = true;
        clearInterval(statusTimer);
        void client.detach().catch(() => client.close());
    });

    const statusTimer = setInterval(() => {
        renderStatus();
    }, 200);

    renderer.on(CliRenderEvents.SELECTION, (selection: Selection) => {
        const copyableNodes = pendingUiRequest !== undefined
                && isToolApprovalUiRequestUpdate(pendingUiRequest)
            ? [approvalView.detailsText]
            : pendingUiRequest !== undefined
                    && isUserQuestionUiRequestUpdate(pendingUiRequest)
                ? [questionView.detailsText]
                : entryNodes;
        if (isTranscriptSelection(selection, copyableNodes)) {
            void copyTranscriptSelection(selection);
        }
    });

    renderer.keyInput.on("keypress", (key) => {
        if (parseRawInputEvent(key)?.type === "interrupt") {
            const action = tuiInterruptAction(
                key,
                state.working,
                abortRequested,
            );
            key.preventDefault();
            key.stopPropagation();
            if (action === "quit") {
                renderer.destroy();
            } else if (action === "abort") {
                abortRequested = true;
                activity = "stopping";
                sendCommand({ type: "abort" });
                renderStatus();
            }
            return;
        }

        if (pendingUiRequest !== undefined) {
            const response = isToolApprovalUiRequestUpdate(pendingUiRequest)
                ? createTuiApprovalResponse(pendingUiRequest, key)
                : createTuiQuestionResponse(pendingUiRequest, key);
            if (response !== undefined) {
                key.preventDefault();
                key.stopPropagation();
                sendCommand(response);
                activity = "thinking";
                pendingUiRequest = undefined;
                focusActiveSurface();
                renderState();
                return;
            }
        }

        if (timelinePicker !== undefined) {
            const transition = handleTuiTimelineKey(
                timelinePicker,
                key,
                randomUUID,
            );
            if (transition.handled) {
                key.preventDefault();
                key.stopPropagation();
                applyTimelineTransition(transition);
                return;
            }
        }

        if (settingsPicker !== undefined) {
            const transition = handleTuiSettingsPickerKey(settingsPicker, key);
            if (transition.handled) {
                key.preventDefault();
                key.stopPropagation();
                applySettingsPickerTransition(transition);
                return;
            }
        }

        if (
            composer.plainText === "/"
            && commandSuggestionsBox.visible
            && !key.ctrl
            && !key.meta
            && !key.super
            && !key.hyper
            && !key.shift
        ) {
            const suggestions = commandRegistry.suggestions("/");
            if (key.name === "up" || key.name === "k") {
                key.preventDefault();
                key.stopPropagation();
                commandSuggestionIndex = Math.max(0, commandSuggestionIndex - 1);
                renderCommandSuggestions();
                return;
            }
            if (key.name === "down" || key.name === "j") {
                key.preventDefault();
                key.stopPropagation();
                commandSuggestionIndex = Math.min(
                    suggestions.length - 1,
                    commandSuggestionIndex + 1,
                );
                renderCommandSuggestions();
                return;
            }
            if (key.name === "return" || key.name === "enter") {
                const selected = suggestions[commandSuggestionIndex];
                if (selected !== undefined) {
                    key.preventDefault();
                    key.stopPropagation();
                    composer.setComposerText(`/${selected.name}`);
                    submitPrompt();
                    return;
                }
            }
        }

        if (
            key.name === "tab"
            && !key.ctrl
            && !key.shift
            && !key.meta
            && !key.option
            && !key.super
            && !key.hyper
        ) {
            const completion = commandRegistry.completion(composer.plainText);
            if (completion !== undefined) {
                key.preventDefault();
                key.stopPropagation();
                composer.setComposerText(completion);
                renderCommandSuggestions();
                return;
            }
            if (commandRegistry.suggestions(composer.plainText).length > 0) {
                // A complete slash command has nothing left to complete. Do
                // not let the textarea's default Tab behavior move the
                // cursor or change focus.
                key.preventDefault();
                key.stopPropagation();
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
            activity = "stopping";
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

        const commandAction = commandRegistry.dispatch(prompt);
        if (commandAction?.type === "command_error") {
            state = appendTuiNotice(state, commandAction.message);
            renderState();
            return;
        }
        if (commandAction?.type === "update_model") {
            composer.clearComposer();
            sendCommand({
                type: "update_model_settings",
                requestId: randomUUID(),
                patch: { model: commandAction.model },
            });
            state = appendTuiNotice(state, `model change requested: ${commandAction.model}`);
            renderState();
            return;
        }
        if (commandAction?.type === "open_model_picker") {
            composer.clearComposer();
            settingsPicker = startTuiSettingsPicker(
                "model",
                state.modelSettings?.model,
                state.modelSettings?.reasoningEffort,
                state.approvalMode,
                state.modelSettings?.availableReasoningEfforts,
            );
            renderState();
            focusActiveSurface();
            return;
        }
        if (commandAction?.type === "update_reasoning") {
            composer.clearComposer();
            sendCommand({
                type: "update_model_settings",
                requestId: randomUUID(),
                patch: { reasoningEffort: commandAction.reasoningEffort },
            });
            state = appendTuiNotice(
                state,
                `reasoning change requested: ${commandAction.reasoningEffort}`,
            );
            renderState();
            return;
        }
        if (commandAction?.type === "open_reasoning_picker") {
            composer.clearComposer();
            settingsPicker = startTuiSettingsPicker(
                "reasoning",
                state.modelSettings?.model,
                state.modelSettings?.reasoningEffort,
                state.approvalMode,
                state.modelSettings?.availableReasoningEfforts,
            );
            renderState();
            focusActiveSurface();
            return;
        }
        if (commandAction?.type === "update_permissions") {
            composer.clearComposer();
            sendCommand({
                type: "update_permissions",
                requestId: randomUUID(),
                mode: commandAction.mode,
            });
            state = appendTuiNotice(
                state,
                `permissions change requested: ${commandAction.mode}`,
            );
            renderState();
            return;
        }
        if (commandAction?.type === "open_permissions_picker") {
            composer.clearComposer();
            settingsPicker = startTuiSettingsPicker(
                "permissions",
                state.modelSettings?.model,
                state.modelSettings?.reasoningEffort,
                state.approvalMode,
                state.modelSettings?.availableReasoningEfforts,
            );
            renderState();
            focusActiveSurface();
            return;
        }
        if (commandAction?.type === "open_rewind") {
            if (
                state.working
                || state.queuedPrompts.length > 0
                || pendingUiRequest !== undefined
                || timelinePicker !== undefined
            ) {
                state = appendTuiNotice(
                    state,
                    "Rewind is available when the agent is idle.",
                );
                renderState();
                return;
            }
            composer.clearComposer();
            applyTimelineTransition(startTuiTimelinePicker(randomUUID()));
            return;
        }

        composer.clearComposer();
        state = state.working
            ? queueTuiPrompt(state, prompt)
            : beginTuiTurn(state, prompt);
        if (workingSince === undefined) {
            workingSince = Date.now();
            activity = "thinking";
        }
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
                    activity = update.type === "ui_request"
                        ? "waiting for approval"
                        : "thinking";
                    const previousRequest = pendingUiRequest;
                    pendingUiRequest = applyTuiUiRequestUpdate(
                        pendingUiRequest,
                        update,
                    );
                    if (pendingUiRequest !== previousRequest) {
                        renderState();
                        focusActiveSurface();
                    }
                    continue;
                }
                if (isTimelineReplyUpdate(update)) {
                    if (timelinePicker !== undefined) {
                        applyTimelineTransition(
                            applyTuiTimelineReply(
                                timelinePicker,
                                update,
                                randomUUID,
                            ),
                        );
                    }
                    continue;
                }
                observeActivity(update);
                state = applyAgentUpdate(state, update);
                if (update.type === "history") {
                    clearTranscriptNodes();
                }
                if (update.type === "turn_finished") {
                    abortRequested = false;
                    finishStreamingAssistant();
                    state = beginNextQueuedTuiTurn(state);
                    if (state.working) {
                        workingSince = Date.now();
                        activity = "thinking";
                    } else {
                        workingSince = undefined;
                        activity = "ready";
                    }
                }
                renderState();

                if (
                    !state.working
                    && pendingUiRequest === undefined
                    && timelinePicker === undefined
                ) {
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

    function focusActiveSurface(): void {
        composer.blur();
        if (
            pendingUiRequest !== undefined
            && isToolApprovalUiRequestUpdate(pendingUiRequest)
        ) {
            approvalView.focus();
            return;
        }
        if (
            pendingUiRequest !== undefined
            && isUserQuestionUiRequestUpdate(pendingUiRequest)
        ) {
            questionView.focus();
            return;
        }
        if (timelinePicker !== undefined) {
            timelinePickerView.box.focus();
            return;
        }
        if (settingsPicker !== undefined) {
            settingsPickerView.box.focus();
            return;
        }
        composer.focus();
    }

    function applyTimelineTransition(
        transition: TuiTimelinePickerTransition,
    ): void {
        timelinePicker = transition.state;
        if (transition.composerText !== undefined) {
            composer.setComposerText(transition.composerText);
        }
        if (transition.command !== undefined) {
            sendCommand(transition.command);
        }
        if (timelinePicker === undefined) {
            timelinePickerView.box.visible = false;
            if (pendingUiRequest === undefined) {
                composer.focus();
            }
        } else {
            composer.blur();
            timelinePickerView.update(timelinePicker);
            if (pendingUiRequest === undefined) {
                timelinePickerView.box.focus();
            }
        }
        renderState();
    }

    function reportConnectionError(error: unknown): void {
        if (shuttingDown) {
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        pendingUiRequest = undefined;
        timelinePicker = undefined;
        settingsPicker = undefined;
        state = appendTuiNotice(state, `Connection error: ${message}`);
        renderState();
        composer.focus();
    }

    function renderState(): void {
        if (shuttingDown) {
            return;
        }

        placeholder.visible = state.entries.length === 0;
        queuedPromptText.content = renderTuiQueuedPrompt(state);
        queuedPromptText.visible = state.queuedPrompts.length > 0;
        approvalView.box.visible = pendingUiRequest?.request.type
            === "tool_approval";
        questionView.box.visible = pendingUiRequest?.request.type
            === "user_question";
        timelinePickerView.box.visible = pendingUiRequest === undefined
            && timelinePicker !== undefined;
        settingsPickerView.box.visible = pendingUiRequest === undefined
            && timelinePicker === undefined
            && settingsPicker !== undefined;
        transcript.opacity = approvalView.box.visible
                || questionView.box.visible
                || timelinePickerView.box.visible
                || settingsPickerView.box.visible
            ? 0.35
            : 1;
        composerBox.visible = pendingUiRequest === undefined
            && timelinePicker === undefined
            && settingsPicker === undefined;
        renderCommandSuggestions();
        if (
            pendingUiRequest !== undefined
            && isToolApprovalUiRequestUpdate(pendingUiRequest)
        ) {
            approvalView.update(pendingUiRequest);
        }
        if (
            pendingUiRequest !== undefined
            && isUserQuestionUiRequestUpdate(pendingUiRequest)
        ) {
            questionView.update(pendingUiRequest);
        }
        if (timelinePicker !== undefined) {
            timelinePickerView.update(timelinePicker);
        }
        if (settingsPicker !== undefined) {
            settingsPickerView.update(settingsPicker);
        }

        while (entryNodes.length > state.entries.length) {
            entryNodes.pop()?.destroy();
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

    function clearTranscriptNodes(): void {
        while (entryNodes.length > 0) {
            entryNodes.pop()?.destroy();
        }
    }

    function applySettingsPickerTransition(
        transition: TuiSettingsPickerTransition,
    ): void {
        settingsPicker = transition.state;
        if (transition.selection !== undefined) {
            const selection = transition.selection;
            if (selection.kind === "model") {
                sendCommand({
                    type: "update_model_settings",
                    requestId: randomUUID(),
                    patch: { model: selection.model },
                });
                state = appendTuiNotice(state, `model change requested: ${selection.model}`);
            } else if (selection.kind === "reasoning") {
                sendCommand({
                    type: "update_model_settings",
                    requestId: randomUUID(),
                    patch: { reasoningEffort: selection.reasoningEffort },
                });
                state = appendTuiNotice(state, `reasoning change requested: ${selection.reasoningEffort}`);
            } else {
                sendCommand({
                    type: "update_permissions",
                    requestId: randomUUID(),
                    mode: selection.mode,
                });
                state = appendTuiNotice(state, `permissions change requested: ${selection.mode}`);
            }
            settingsPicker = undefined;
        }
        if (settingsPicker === undefined) {
            settingsPickerView.box.visible = false;
            if (pendingUiRequest === undefined) {
                composer.focus();
            }
        } else {
            composer.blur();
            settingsPickerView.update(settingsPicker);
            settingsPickerView.box.focus();
        }
        renderState();
    }

    function renderCommandSuggestions(): void {
        if (composer.plainText.length === 0) {
            commandSuggestionIndex = 0;
        }
        const suggestions = commandRegistry.suggestions(composer.plainText);
        commandSuggestionIndex = Math.min(
            commandSuggestionIndex,
            Math.max(0, suggestions.length - 1),
        );
        commandSuggestionsText.content = renderTuiCommandSuggestions(
            suggestions,
            composer.plainText === "/" ? commandSuggestionIndex : -1,
        );
        // Leave room for every matching command. The old fixed three-row box
        // clipped the catalog to its first entry, which made the other slash
        // commands appear to be missing.
        commandSuggestionsBox.height = suggestions.length > 0
            ? suggestions.length + 2
            : 3;
        commandSuggestionsBox.visible = suggestions.length > 0
            && pendingUiRequest === undefined
            && timelinePicker === undefined
            && settingsPicker === undefined;
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
            await copyText(text);
            if (shuttingDown) {
                return;
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
            lifecycleHint = `${STOPPING_HINT} · ${elapsedWorkingTime()}`;
        } else if (pendingUiRequest?.request.type === "tool_approval") {
            lifecycleHint = `${APPROVAL_HINT} · ${elapsedWorkingTime()}`;
        } else if (pendingUiRequest?.request.type === "user_question") {
            lifecycleHint = `${QUESTION_HINT} · ${elapsedWorkingTime()}`;
        } else if (state.working) {
            lifecycleHint = `${progressFrame()} ${activity} · ${elapsedWorkingTime()} · ${WORKING_HINT}`;
        }

        statusText.fg = statusNotice !== undefined
            ? TUI_NOTICE
            : state.working || pendingUiRequest !== undefined
                ? TUI_ACCENT
                : "#565B66";
        statusText.content = renderTuiStatusLine(
            state.modelSettings,
            state.approvalMode,
            statusNotice ?? lifecycleHint,
        );
    }

    function observeActivity(update: AgentUpdate): void {
        if (update.type === "user_prompt") {
            workingSince ??= Date.now();
            activity = "thinking";
        } else if (update.type === "assistant_delta") {
            workingSince ??= Date.now();
            activity = "responding";
        } else if (update.type === "tool_started") {
            workingSince ??= Date.now();
            activity = `running ${update.tool}`;
        } else if (update.type === "tool_finished") {
            activity = "thinking";
        }
    }

    function elapsedWorkingTime(): string {
        if (workingSince === undefined) {
            return "0s";
        }
        const elapsedSeconds = Math.max(
            0,
            Math.floor((Date.now() - workingSince) / 1_000),
        );
        const minutes = Math.floor(elapsedSeconds / 60);
        const seconds = elapsedSeconds % 60;
        return minutes === 0
            ? `${seconds}s`
            : `${minutes}m${String(seconds).padStart(2, "0")}s`;
    }

    function progressFrame(): string {
        const index = Math.floor(Date.now() / 200) % PROGRESS_FRAMES.length;
        return PROGRESS_FRAMES[index] ?? "⠋";
    }
}

function applyTuiUiRequestUpdate(
    current: UiRequestUpdate | undefined,
    update: AgentUpdate,
): UiRequestUpdate | undefined {
    if (update.type === "ui_request") {
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
