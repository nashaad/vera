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
import type { UserMessage } from "../../src/model/types.ts";
import type { ReasoningLevel } from "../../src/model/catalog-shape.ts";
import {
    loadOptionalVeraConfig,
    type VeraExtensionConfig,
} from "../../src/config.ts";
import {
    bundledClientExtensionConfigs,
    bundledClientExtensions,
} from "../../src/extensions/bundled-client.ts";
import { invokeDirectClientExtensionCommand } from "../../src/extensions/client.ts";
import {
    startClientExtensionRegistry,
    type ClientExtensionRegistry,
} from "../../src/extensions/client-registry.ts";
import type {
    VeraClientModelSettingsPatch,
    VeraClientModelSettingsUpdateResult,
    VeraClientPickerRequest,
    VeraClientPickerResult,
} from "../../src/sdk/extensions.ts";
import type { ExtensionCommandDescriptor } from "../../src/extensions/commands.ts";
import type {
    TuiTimelinePickerState,
    TuiTimelinePickerTransition,
} from "./timeline-picker.ts";
import {
    branchAgentThroughHost,
    createAgentThroughHost,
    resumeAgentThroughHost,
} from "../../src/host/agent-start-client.ts";
import {
    attachAgent,
    type AttachedAgentClient,
} from "../../src/host/attached-client.ts";
import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import {
    trashSessionThroughHost,
    type TrashSessionResult,
} from "../../src/host/session-trash-client.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import { findOrStartResidentHost } from "../host/launch.ts";
import {
    createTuiApprovalView,
    createTuiApprovalResponse,
    tuiApprovalHint,
} from "./approval.ts";
import {
    createTuiQuestionView,
} from "./question.ts";
import { applyTuiUiRequestUpdate } from "./ui-request-queue.ts";
import { copyTuiText, countTuiCharacters } from "./clipboard.ts";
import {
    createTuiCommandPaletteView,
    handleTuiCommandPaletteKey,
    startTuiCommandPalette,
    updateTuiCommandPaletteCommands,
    type TuiCommandPaletteState,
} from "./command-palette.ts";
import {
    createTuiHelpView,
    handleTuiHelpKey,
    startTuiHelp,
    updateTuiHelpCommands,
    type TuiHelpState,
} from "./help.ts";
import {
    createConfiguredBuiltinTuiCommandRegistry,
    extensionCommandResultText,
    registerExtensionTuiCommands,
    renderTuiCommandSuggestions,
    type TuiCommandAction,
    type TuiPaletteEntry,
} from "./commands.ts";
import { createTuiComposer, createTuiComposerPanel } from "./composer.ts";
import { renderTuiActivityAnimation } from "./activity-pulse.ts";
import { TuiBodyFocusController } from "./body-focus.ts";
import {
    createTuiPermissionsConfirmView,
    handleTuiPermissionsConfirmKey,
} from "./permissions-confirm.ts";
import {
    createTuiSessionTrashConfirmView,
    handleTuiSessionTrashConfirmKey,
} from "./session-trash-confirm.ts";
import { parseRawInputEvent, tuiInterruptAction } from "./interrupt.ts";
import { isTranscriptSelection } from "./selection.ts";
import {
    countRunningBackgroundAgents,
    renderTuiStatusDetailsLine,
} from "./status.ts";
import {
    createTuiSettingsPickerView,
    handleTuiSettingsPickerKey,
    startTuiSettingsMenu,
    startTuiSettingsPicker,
    syncTuiModelPicker,
    startTuiReasoningPicker,
    startTuiSessionPicker,
    startTuiExtensionPicker,
    type TuiSettingsMenuTarget,
    type TuiAnySettingsPickerState,
    type TuiSettingsPickerState,
    type TuiSettingsPickerTransition,
    type TuiExtensionPickerAction,
    type TuiExtensionPickerTransition,
} from "./settings-picker.ts";
import { renderPermissionInspection } from "./permission-inspection.ts";
import {
    createTuiPreferencesListView,
    handleTuiPreferencesListKey,
    startTuiPreferencesList,
    syncTuiPreferencesList,
    type TuiPreferencesListState,
} from "./preferences-list.ts";
import {
    resolveResumeTarget,
    type TuiStartTarget,
} from "./session-target.ts";
export type {
    AttachTuiTarget,
    CreateTuiTarget,
    ResumeTuiTarget,
    TuiStartTarget,
} from "./session-target.ts";
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
    applyTuiTheme,
    appendTuiNotice,
    appendTuiThought,
    applyAgentUpdate,
    beginNextQueuedTuiTurn,
    beginTuiTurn,
    createTuiState,
    failTuiConnection,
    queueTuiPrompt,
    renderTuiEntry,
    renderTuiQueuedPrompt,
    tuiEntryMarginTop,
} from "./state.ts";
import { resolveTuiTheme, VERA_TUI_THEME } from "./theme.ts";
import {
    loadTuiActivityAnimationPreference,
    loadTuiActivityAnimationIntervalPreference,
    loadTuiActivityAnimationWidthPreference,
    loadTuiThemePreference,
    loadTuiExtensionPreference,
    deleteTuiExtensionPreference,
    saveTuiExtensionPreference,
    saveTuiThemePreference,
} from "./theme-preference.ts";
import { createTuiDiff } from "./diff.ts";
import { createTuiMarkdownEntry } from "./markdown-entry.ts";

// The palette has no other advertisement: it is a chord, not a slash command in
// the composer's list, so the idle status line is where you find out it exists.
const READY_HINT = "ready · ctrl+p commands";
const WORKING_HINT = "enter queue · esc redirect/stop · ctrl+c stop";
const STOPPING_HINT = "stopping…";
// The question overlay owns the choose/cancel hint now, so the status line only
// carries the waiting phase and the global interrupt.
const QUESTION_HINT = "question waiting · ctrl+c stop";
const COPY_NOTICE_DURATION_MS = 1_500;
const STATUS_REFRESH_INTERVAL_MS = 100;
const BACKGROUND_AGENT_REFRESH_INTERVAL_MS = 1_000;
const DIRECT_EXTENSION_COMMAND_TIMEOUT_MS = 2_000;
const SYMMETRIC_WAVE_FRAME_INTERVAL_MS = 360;
const DEFAULT_ACTIVITY_FRAME_INTERVAL_MS = 160;
const SESSION_SWITCH_TIMEOUT_MS = 15_000;

function normalizedExtensionKey(key: {
    readonly name: string;
    readonly ctrl?: boolean;
    readonly shift?: boolean;
    readonly meta?: boolean;
    readonly option?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
}): string | undefined {
    if (key.meta || key.option || key.super || key.hyper) {
        return undefined;
    }
    const modifiers = [
        ...(key.ctrl ? ["ctrl"] : []),
        ...(key.shift ? ["shift"] : []),
    ];
    return [...modifiers, key.name].join("+");
}

export interface TuiDependencies {
    readonly client: TuiAgentClient;
    readonly copyText?: (text: string) => Promise<void>;
    readonly listAgents?: () => Promise<readonly RegisteredAgentSummary[]>;
    readonly getRunningBackgroundAgentCount?: () => Promise<number>;
    readonly createSession?: () => Promise<TuiAgentClient>;
    readonly cloneSession?: () => Promise<TuiAgentClient>;
    readonly forkSession?: (
        boundaryId: string,
    ) => Promise<{ readonly client: TuiAgentClient; readonly prompt: UserMessage }>;
    readonly initialDraft?: TuiDraft;
    readonly sessionSwitchTimeoutMs?: number;
    readonly trashSession?: (sessionId: string) => Promise<TrashSessionResult>;
    readonly disabledBuiltinExtensions?: readonly string[];
    readonly clientExtensions?: readonly VeraExtensionConfig[];
}

export interface TuiDraft {
    readonly text: string;
    readonly attachmentIds: readonly string[];
}

export interface TuiExit {
    readonly nextClient?: TuiAgentClient;
    readonly nextDraft?: TuiDraft;
    readonly resumeSessionPath?: string;
}

export interface TuiAgentClient {
    readonly agentId?: string;
    readonly workspace?: string;
    send(command: ClientCommand): Promise<void>;
    receive(signal?: AbortSignal): Promise<AgentUpdate>;
    listExtensionCommands?: AttachedAgentClient["listExtensionCommands"];
    runExtensionCommand?: AttachedAgentClient["runExtensionCommand"];
    detach(): Promise<void>;
    close(): void;
}

export interface TuiStartOptions {
    readonly confirmBusyUpgrade?: (error: Error) => boolean | Promise<boolean>;
}

function removeSessionPickerOption(
    picker: TuiSettingsPickerState | undefined,
    sessionId: string,
): TuiSettingsPickerState | undefined {
    if (picker?.kind !== "session") return picker;
    const allOptions = picker.allOptions.filter(
        (option) => option.sessionId !== sessionId,
    );
    const options = picker.options.filter(
        (option) => option.sessionId !== sessionId,
    );
    return {
        ...picker,
        allOptions,
        options,
        selectedIndex: Math.min(
            picker.selectedIndex,
            Math.max(0, options.length - 1),
        ),
    };
}

if (import.meta.main) {
    await startConfiguredTui({
        type: "create",
        workspace: process.cwd(),
    });
}

export async function startConfiguredTui(
    target: TuiStartTarget,
    options: TuiStartOptions = {},
): Promise<void> {
    // Optional on purpose: the host owns the config, and the only fields read
    // here are the client's own extension lists. Requiring the file made
    // `vera attach` against an already-running host fail on a fresh machine.
    const config = loadOptionalVeraConfig();
    const host = await findOrStartResidentHost({
        ...(options.confirmBusyUpgrade === undefined
            ? {}
            : { confirmBusyUpgrade: options.confirmBusyUpgrade }),
    });
    const resolvedTarget = target.type === "resume"
        ? resolveResumeTarget(
            await listAgentsThroughHost(host.socket_path),
            target.sessionPath,
        )
        : target;
    let agentId = resolvedTarget.type === "create"
        ? (await createAgentThroughHost(
            host.socket_path,
            resolvedTarget.workspace,
        )).id
        : resolvedTarget.type === "resume"
            ? (await resumeAgentThroughHost(
                host.socket_path,
                resolvedTarget.sessionPath,
            )).id
            : resolvedTarget.agentId;
    let preparedClient: TuiAgentClient | undefined;
    let preparedDraft: TuiDraft | undefined;
    while (true) {
        const client = preparedClient ?? await attachAgent({
            socketPath: host.socket_path,
            agentId,
        });
        preparedClient = undefined;
        const initialDraft = preparedDraft;
        preparedDraft = undefined;
        try {
            const listAgents = () => listAgentsThroughHost(host.socket_path);
            const exit = await startTui({
                client,
                listAgents,
                getRunningBackgroundAgentCount: async () =>
                    countRunningBackgroundAgents(await listAgents()),
                createSession: async () => {
                    if (client.workspace === undefined) {
                        throw new Error("Current session workspace is unavailable");
                    }
                    const ready = await createAgentThroughHost(
                        host.socket_path,
                        client.workspace,
                    );
                    return attachAgent({
                        socketPath: host.socket_path,
                        agentId: ready.id,
                    });
                },
                cloneSession: async () => {
                    if (client.agentId === undefined) {
                        throw new Error("Current session ID is unavailable");
                    }
                    const ready = await branchAgentThroughHost(
                        host.socket_path,
                        client.agentId,
                        "at",
                    );
                    return attachAgent({
                        socketPath: host.socket_path,
                        agentId: ready.id,
                    });
                },
                forkSession: async (boundaryId) => {
                    if (client.agentId === undefined) {
                        throw new Error("Current session ID is unavailable");
                    }
                    const ready = await branchAgentThroughHost(
                        host.socket_path,
                        client.agentId,
                        "before",
                        boundaryId,
                    );
                    if (ready.prompt === undefined) {
                        throw new Error("Host did not return the fork prompt");
                    }
                    return {
                        client: await attachAgent({
                            socketPath: host.socket_path,
                            agentId: ready.id,
                        }),
                        prompt: ready.prompt,
                    };
                },
                trashSession: (sessionId) =>
                    trashSessionThroughHost(host.socket_path, sessionId),
                ...(initialDraft === undefined
                    ? {}
                    : { initialDraft }),
                ...(config?.disabled_builtin_extensions === undefined
                    ? {}
                    : {
                        disabledBuiltinExtensions:
                            config.disabled_builtin_extensions,
                    }),
                ...(config?.extensions === undefined
                    ? {}
                    : { clientExtensions: config.extensions }),
            });
            if (exit.nextClient !== undefined) {
                preparedClient = exit.nextClient;
                preparedDraft = exit.nextDraft;
                agentId = exit.nextClient.agentId ?? agentId;
                continue;
            }
            if (exit.resumeSessionPath === undefined) {
                return;
            }
            agentId = (await resumeAgentThroughHost(
                host.socket_path,
                exit.resumeSessionPath,
            )).id;
        } catch (error) {
            client.close();
            throw error;
        }
    }
}

export async function startTui(
    dependencies: TuiDependencies,
): Promise<TuiExit> {
    const { client } = dependencies;
    const renderer = await createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 30,
    });
    const copyText = dependencies.copyText
        ?? ((text: string) => copyTuiText(text, renderer));
    renderer.setTerminalTitle("Vera");
    let themeName = loadTuiThemePreference();
    let activityAnimation = loadTuiActivityAnimationPreference();
    const activityAnimationInterval =
        loadTuiActivityAnimationIntervalPreference();
    const activityAnimationWidth = loadTuiActivityAnimationWidthPreference();
    let theme = await resolveTuiTheme(renderer, themeName);
    applyTuiTheme(theme);
    renderer.setBackgroundColor(theme.background);

    let state = createTuiState();
    let connectionFailed = false;
    let statusNotice: string | undefined;
    let statusNoticeVersion = 0;
    let shuttingDown = false;
    let abortRequested = false;
    let pendingUiRequest: UiRequestUpdate | undefined;
    const queuedUiRequests: UiRequestUpdate[] = [];
    let timelinePicker: TuiTimelinePickerState | undefined;
    let settingsPicker: TuiAnySettingsPickerState | undefined;
    let pendingExtensionPicker: {
        readonly resolve: (result: VeraClientPickerResult) => void;
        readonly reject: (error: unknown) => void;
        readonly removeAbortListener: () => void;
    } | undefined;
    const pendingExtensionSettings = new Map<
        string,
        {
            readonly resolve: (
                result: VeraClientModelSettingsUpdateResult,
            ) => void;
            readonly reject: (error: unknown) => void;
            readonly removeAbortListener: () => void;
        }
    >();
    const extensionSettingsListeners = new Set<
        (settings: NonNullable<typeof state.modelSettings>) => void
    >();
    let clientExtensionRegistry: ClientExtensionRegistry | undefined;
    let preferencesList: TuiPreferencesListState | undefined;
    let commandPalette: TuiCommandPaletteState | undefined;
    let help: TuiHelpState | undefined;
    let hostExtensionCommands: readonly ExtensionCommandDescriptor[] = [];
    let confirmingFullAccess = false;
    let sessionTrashCandidate: {
        readonly sessionId: string;
        readonly label: string;
    } | undefined;
    let sessionTrashPending = false;
    let commandSuggestionIndex = 0;
    let workingSince: number | undefined;
    let phaseSince: number | undefined;
    let activity = "thinking";
    let themeApplicationVersion = 0;
    let resumeSessionPath: string | undefined;
    let nextClient: TuiAgentClient | undefined;
    let nextDraft: TuiDraft | undefined;
    let resumeListVersion = 0;
    let promptSubmitting = false;
    let sessionSwitchPending = false;
    let sessionSwitchActivity = "starting new session…";
    let extensionCommandPending = false;
    let extensionCommandActivity: string | undefined;
    let extensionCommandsLoading =
        dependencies.client.listExtensionCommands !== undefined;
    let runningBackgroundAgents = 0;
    let backgroundAgentRefreshPending = false;
    let pendingSessionRename: {
        readonly requestId: string;
        readonly commandText: string;
    } | undefined;
    let submitAfterImageAttachment = false;
    let pendingImages: Array<{
        requestId: string;
        id?: string;
        name?: string;
    }> = [];
    if (dependencies.initialDraft !== undefined) {
        pendingImages = dependencies.initialDraft.attachmentIds.map((id) => ({
            requestId: randomUUID(),
            id,
        }));
    }
    const finished = Promise.withResolvers<TuiExit>();
    const disabledBuiltinExtensions =
        dependencies.disabledBuiltinExtensions ?? [];
    const commandRegistry = createConfiguredBuiltinTuiCommandRegistry(
        disabledBuiltinExtensions,
    );
    clientExtensionRegistry = await startClientExtensionRegistry({
        extensions: [
            ...bundledClientExtensionConfigs(disabledBuiltinExtensions),
            ...(dependencies.clientExtensions ?? []),
        ],
        preferences: {
            async get(namespace, key) {
                return loadTuiExtensionPreference(namespace, key);
            },
            async set(namespace, key, value) {
                saveTuiExtensionPreference(namespace, key, value);
            },
            async delete(namespace, key) {
                deleteTuiExtensionPreference(namespace, key);
            },
        },
        modelSettings: {
            current: () => state.modelSettings,
            update: requestExtensionModelSettingsUpdate,
            subscribe(listener) {
                extensionSettingsListeners.add(listener);
                return () => {
                    extensionSettingsListeners.delete(listener);
                };
            },
        },
        picker: {
            request: (_extensionId, request, signal) =>
                requestExtensionPicker(request, signal),
        },
        reservedCommandNames:
            commandRegistry.registeredCommands().map(({ name }) => name),
        reservedKeybindingKeys: [],
        onFailure(failure) {
            state = appendTuiNotice(
                state,
                `${failure.extensionId ?? failure.path}: ${failure.message}`,
            );
        },
    });
    registerExtensionTuiCommands(
        commandRegistry,
        clientExtensionRegistry.commands(),
        "client",
    );
    const directClientExtensions = bundledClientExtensions();
    for (const extension of directClientExtensions) {
        if (
            extension.commands.some(
                (command) => command.source !== extension.id,
            )
        ) {
            throw new Error(
                `Direct extension ${extension.id} returned a command for another source`,
            );
        }
        registerExtensionTuiCommands(
            commandRegistry,
            extension.commands,
            "direct",
        );
    }
    const coreHelpCommands = commandRegistry.registeredCommands();

    function registeredPaletteEntries(): readonly TuiPaletteEntry[] {
        // Every command that belongs in the palette declares its own row, so
        // there is nothing left to synthesize from the slash catalog.
        return commandRegistry.registeredPaletteActions();
    }

    let markdownStyle = createMarkdownStyle(theme);
    function createMarkdownStyle(activeTheme: typeof theme): SyntaxStyle {
        return SyntaxStyle.fromStyles({
        default: { fg: activeTheme.text },
        "markup.heading": { fg: activeTheme.accent, bold: true },
        "markup.strong": { bold: true },
        "markup.italic": { italic: true },
        "markup.raw": { fg: activeTheme.success },
        "markup.raw.block": { fg: activeTheme.success },
        "markup.list": { fg: activeTheme.accent },
        "markup.quote": { fg: activeTheme.muted, italic: true },
        "markup.link": { fg: activeTheme.accent, underline: true },
        "markup.link.label": { fg: activeTheme.accent },
        "markup.link.url": { fg: activeTheme.muted, underline: true },
        comment: { fg: activeTheme.muted, italic: true },
        string: { fg: activeTheme.success },
        number: { fg: activeTheme.notice },
        boolean: { fg: activeTheme.notice },
        keyword: { fg: activeTheme.accent },
        type: { fg: activeTheme.notice },
        "type.builtin": { fg: activeTheme.notice },
        function: { fg: activeTheme.accent },
        "function.call": { fg: activeTheme.accent },
        constant: { fg: activeTheme.notice },
        operator: { fg: activeTheme.muted },
        conceal: { fg: activeTheme.muted },
        });
    }

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

    const entryNodes: (TextRenderable | MarkdownRenderable | BoxRenderable)[] = [];

    const statusText = new TextRenderable(renderer, {
        id: "status",
        content: READY_HINT,
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        paddingLeft: 3,
        position: "absolute",
        left: 1,
        bottom: 1,
        zIndex: 30,
        bg: theme.background,
    });
    const backgroundStatusText = new TextRenderable(renderer, {
        id: "background-status",
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        paddingLeft: 3,
        position: "absolute",
        left: 1,
        bottom: 0,
        zIndex: 30,
        bg: theme.background,
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

    const composer = createTuiComposer(
        renderer,
        submitPrompt,
        attachPastedImage,
    );
    if (dependencies.initialDraft !== undefined) {
        composer.setComposerText(dependencies.initialDraft.text);
    }
    const timelinePickerView = createTuiTimelinePickerView(renderer);
    const settingsPickerView = createTuiSettingsPickerView(renderer);
    const preferencesListView = createTuiPreferencesListView(renderer);
    const commandPaletteView = createTuiCommandPaletteView(renderer);
    const helpView = createTuiHelpView(renderer);
    const permissionsConfirmView = createTuiPermissionsConfirmView(renderer);
    const sessionTrashConfirmView =
        createTuiSessionTrashConfirmView(renderer);
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
        border: false,
        width: "100%",
        height: 1,
        paddingLeft: 1,
        paddingRight: 1,
        visible: false,
    });
    commandSuggestionsBox.add(commandSuggestionsText);
    composer.onContentChange = renderCommandSuggestions;

    const composerBox = createTuiComposerPanel(renderer, composer);

    const bodyFocus = new TuiBodyFocusController();
    const app = new BoxRenderable(renderer, {
        id: "app",
        width: "100%",
        height: "100%",
        flexDirection: "column",
        gap: 1,
        paddingTop: 1,
        paddingBottom: 0,
        onMouseDrag: () => bodyFocus.noteDrag(),
        onMouseDragEnd: () => bodyFocus.noteDrag(),
        onMouseUp: () => {
            if (bodyFocus.release(anyOverlayOpen())) {
                composer.focus();
            }
        },
    });
    app.add(transcript);
    app.add(queuedPromptText);
    app.add(approvalView.box);
    app.add(questionView.box);
    app.add(timelinePickerView.box);
    app.add(settingsPickerView.box);
    app.add(preferencesListView.box);
    app.add(commandPaletteView.box);
    app.add(helpView.box);
    app.add(permissionsConfirmView.box);
    app.add(sessionTrashConfirmView.box);
    app.add(commandSuggestionsBox);
    app.add(composerBox);
    app.add(statusText);
    app.add(backgroundStatusText);
    renderer.root.add(app);
    composer.focus();
    renderStatus();

    renderer.on(CliRenderEvents.DESTROY, () => {
        shuttingDown = true;
        clearInterval(statusTimer);
        clearInterval(backgroundAgentTimer);
        const picker = pendingExtensionPicker;
        pendingExtensionPicker = undefined;
        picker?.removeAbortListener();
        picker?.resolve({ outcome: "cancelled" });
        for (const pending of pendingExtensionSettings.values()) {
            pending.removeAbortListener();
            pending.reject(new Error("TUI is closing"));
        }
        pendingExtensionSettings.clear();
        void Promise.resolve(clientExtensionRegistry?.close())
            .catch(() => undefined)
            .then(() => client.detach().catch(() => client.close()))
            .then(() => {
            finished.resolve({
                ...(nextClient === undefined
                    ? {}
                    : { nextClient }),
                ...(nextDraft === undefined ? {} : { nextDraft }),
                ...(resumeSessionPath === undefined
                    ? {}
                    : { resumeSessionPath }),
            });
            });
    });

    const statusTimer = setInterval(() => {
        renderStatus();
    }, STATUS_REFRESH_INTERVAL_MS);
    const backgroundAgentTimer = setInterval(() => {
        void refreshBackgroundAgentCount();
    }, BACKGROUND_AGENT_REFRESH_INTERVAL_MS);
    void refreshBackgroundAgentCount();

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
        if (parseRawInputEvent(key)?.type === "open_palette") {
            key.preventDefault();
            key.stopPropagation();
            // A second ctrl+p closes the palette, so the chord toggles rather
            // than reopening a palette that is already in front of you.
            if (commandPalette !== undefined) {
                commandPalette = undefined;
                commandPaletteView.box.visible = false;
                composer.focus();
                renderState();
                return;
            }
            if (pendingUiRequest === undefined && !sessionSwitchPending) {
                openCommandPalette();
            }
            return;
        }
        if (parseRawInputEvent(key)?.type === "interrupt") {
            if (sessionSwitchPending) {
                key.preventDefault();
                key.stopPropagation();
                return;
            }
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

        if (
            pendingUiRequest !== undefined
            && isUserQuestionUiRequestUpdate(pendingUiRequest)
        ) {
            // Arrow keys move the highlight (no engine message); numbers, Enter,
            // and Escape resolve the question. Selection stays client-local.
            const result = questionView.handleKey(pendingUiRequest, key);
            if (result.handled) {
                key.preventDefault();
                key.stopPropagation();
                if (result.response !== undefined) {
                    sendCommand(result.response);
                    activity = "thinking";
                    focusActiveSurface();
                }
                renderState();
                return;
            }
        } else if (pendingUiRequest !== undefined) {
            const response = createTuiApprovalResponse(pendingUiRequest, key);
            if (response !== undefined) {
                key.preventDefault();
                key.stopPropagation();
                sendCommand(response);
                activity = "thinking";
                focusActiveSurface();
                renderState();
                return;
            }
        }

        if (sessionTrashCandidate !== undefined) {
            if (sessionTrashPending) {
                key.preventDefault();
                key.stopPropagation();
                return;
            }
            const result = handleTuiSessionTrashConfirmKey(key);
            key.preventDefault();
            key.stopPropagation();
            if (result !== undefined) {
                if (result === "confirm") {
                    beginSessionTrash(sessionTrashCandidate);
                } else {
                    sessionTrashCandidate = undefined;
                    state = appendTuiNotice(state, "conversation kept");
                    focusActiveSurface();
                    renderState();
                }
            }
            return;
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

        if (confirmingFullAccess) {
            const result = handleTuiPermissionsConfirmKey(key);
            if (result !== undefined) {
                key.preventDefault();
                key.stopPropagation();
                confirmingFullAccess = false;
                if (result === "confirm") {
                    requestPermissionsChange("full_access");
                } else {
                    state = appendTuiNotice(state, "full access unchanged");
                }
                focusActiveSurface();
                renderState();
                return;
            }
        }

        if (settingsPicker !== undefined) {
            const transition = settingsPicker.kind === "extension"
                ? handleTuiSettingsPickerKey(settingsPicker, key)
                : handleTuiSettingsPickerKey(settingsPicker, key);
            if (transition.handled) {
                key.preventDefault();
                key.stopPropagation();
                applySettingsPickerTransition(transition);
                return;
            }
        }

        if (preferencesList !== undefined) {
            const transition = handleTuiPreferencesListKey(preferencesList, key);
            if (transition.handled) {
                key.preventDefault();
                key.stopPropagation();
                preferencesList = transition.state;
                if (transition.remove !== undefined) {
                    // The row's own kind picks the command. The two tiers live in
                    // different stores, so one command covering both would have
                    // to guess which store an ID belongs to.
                    sendCommand({
                        type: transition.remove.kind === "grant"
                            ? "remove_permission_grant"
                            : "remove_permission_preference",
                        requestId: randomUUID(),
                        id: transition.remove.id,
                    });
                }
                if (preferencesList === undefined) {
                    preferencesListView.box.visible = false;
                    composer.focus();
                }
                renderState();
                return;
            }
        }

        if (commandPalette !== undefined) {
            const transition = handleTuiCommandPaletteKey(commandPalette, key);
            if (transition.handled) {
                key.preventDefault();
                key.stopPropagation();
                commandPalette = transition.state;
                if (transition.selection !== undefined) {
                    const selected = transition.selection;
                    commandPalette = undefined;
                    runPaletteAction(selected);
                } else {
                    renderState();
                    focusActiveSurface();
                }
                return;
            }
        }

        if (help !== undefined) {
            const transition = handleTuiHelpKey(help, key);
            if (transition.handled) {
                key.preventDefault();
                key.stopPropagation();
                help = transition.state;
                renderState();
                focusActiveSurface();
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
            key.name === "escape"
            && !key.ctrl
            && !key.shift
            && !key.meta
            && composer.plainText.length > 0
        ) {
            key.preventDefault();
            key.stopPropagation();
            composer.clearComposer();
            renderCommandSuggestions();
            renderState();
            composer.focus();
            return;
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

        const extensionKey = normalizedExtensionKey(key);
        const extensionBinding = extensionKey === undefined
            ? undefined
            : clientExtensionRegistry?.keybindings().find((binding) =>
                binding.keys.includes(extensionKey)
            );
        if (extensionBinding !== undefined && !anyOverlayOpen()) {
            key.preventDefault();
            key.stopPropagation();
            void clientExtensionRegistry!.invokeKeybinding(
                extensionBinding.id,
                client.workspace ?? process.cwd(),
            ).catch((error) => {
                state = appendTuiNotice(
                    state,
                    error instanceof Error ? error.message : String(error),
                );
                renderState();
            });
            return;
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
    void loadExtensionCommands();
    sendCommand({
        type: "get_model_settings",
        requestId: randomUUID(),
    });
    sendCommand({
        type: "get_permissions",
        requestId: randomUUID(),
    });

    function submitPrompt(): void {
        if (
            promptSubmitting
            || sessionSwitchPending
            || pendingSessionRename
            || extensionCommandPending
        ) {
            return;
        }
        const prompt = composer.expandedText().trim();
        if (prompt.length === 0 && pendingImages.length === 0) {
            return;
        }

        const commandAction = prompt.length === 0
            ? undefined
            : commandRegistry.dispatch(prompt);
        if (
            commandAction === undefined
            && extensionCommandsLoading
            && prompt.startsWith("/")
        ) {
            state = appendTuiNotice(
                state,
                "Extension commands are still loading",
            );
            renderState();
            return;
        }
        if (commandAction?.type === "command_error") {
            state = appendTuiNotice(state, commandAction.message);
            renderState();
            return;
        }
        if (commandAction?.type === "run_extension") {
            const directExtension = directClientExtensions.find(
                (extension) =>
                    commandAction.origin === "direct"
                    && extension.id === commandAction.source,
            );
            if (state.working && commandAction.origin === "host") {
                state = appendTuiNotice(
                    state,
                    "Extension commands are available when the agent is idle",
                );
                renderState();
                return;
            }
            composer.rememberSubmittedText(prompt);
            composer.clearComposer();
            renderCommandSuggestions();
            if (
                (commandAction.origin === "direct"
                    && directExtension === undefined)
                || (commandAction.origin === "client"
                    && clientExtensionRegistry === undefined)
                || (commandAction.origin === "host"
                    && client.runExtensionCommand === undefined)
            ) {
                composer.setComposerText(prompt);
                state = appendTuiNotice(
                    state,
                    `${commandAction.source}: command unavailable`,
                );
                renderState();
                return;
            }
            extensionCommandPending = true;
            extensionCommandActivity = `running /${commandAction.command}`;
            renderStatus();
            const invocation = commandAction.origin === "host"
                ? client.runExtensionCommand!(
                    commandAction.command,
                    commandAction.argumentsText,
                )
                : commandAction.origin === "client"
                ? clientExtensionRegistry!.invokeCommand(
                    commandAction.command,
                    commandAction.argumentsText,
                    client.workspace ?? process.cwd(),
                )
                : invokeDirectClientExtensionCommand(
                    directExtension!,
                    commandAction.command,
                    commandAction.argumentsText,
                    { timeoutMs: DIRECT_EXTENSION_COMMAND_TIMEOUT_MS },
                );
            void invocation.then((result) => {
                if (shuttingDown || result === undefined) {
                    return;
                }
                if (result.body.kind === "client_action") {
                    if (result.body.action === "show_help") {
                        help = startTuiHelp(
                            coreHelpCommands,
                            hostExtensionCommands,
                        );
                    }
                } else {
                    state = appendTuiNotice(
                        state,
                        extensionCommandResultText({
                            version: 1,
                            source: result.source,
                            body: result.body,
                        }),
                    );
                }
            }).catch((error) => {
                if (shuttingDown) {
                    return;
                }
                const message = error instanceof Error
                    ? error.message
                    : String(error);
                state = appendTuiNotice(
                    state,
                    `${commandAction.source}/${commandAction.command}: ${message}`,
                );
                if (composer.plainText.length === 0) {
                    composer.setComposerText(prompt);
                    renderCommandSuggestions();
                }
            }).finally(() => {
                if (!shuttingDown) {
                    extensionCommandPending = false;
                    extensionCommandActivity = undefined;
                    renderState();
                    focusActiveSurface();
                }
            });
            return;
        }
        if (
            connectionFailed
            && commandAction?.type !== "open_resume_picker"
            && commandAction?.type !== "open_theme_picker"
            && commandAction?.type !== "create_session"
        ) {
            renderStatus();
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
            openModelPicker();
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
            openReasoningPicker();
            return;
        }
        if (commandAction?.type === "update_permissions") {
            composer.clearComposer();
            if (commandAction.mode === "full_access") {
                confirmingFullAccess = true;
                focusActiveSurface();
            } else {
                requestPermissionsChange(commandAction.mode);
            }
            renderState();
            return;
        }
        if (commandAction?.type === "open_preferences_list") {
            composer.clearComposer();
            openPreferencesList();
            return;
        }
        if (commandAction?.type === "open_permissions_picker") {
            composer.clearComposer();
            openPermissionsPicker();
            return;
        }
        if (commandAction?.type === "open_theme_picker") {
            composer.clearComposer();
            openThemePicker();
            return;
        }
        if (commandAction?.type === "open_settings_menu") {
            composer.clearComposer();
            openSettingsMenu();
            return;
        }
        if (commandAction?.type === "open_command_palette") {
            composer.clearComposer();
            openCommandPalette();
            return;
        }
        if (commandAction?.type === "prefill_composer") {
            composer.setComposerText(commandAction.text);
            renderCommandSuggestions();
            renderState();
            composer.focus();
            return;
        }
        if (commandAction?.type === "open_resume_picker") {
            composer.clearComposer();
            renderCommandSuggestions();
            if (dependencies.listAgents === undefined) {
                state = appendTuiNotice(state, "Session listing is unavailable");
                renderState();
                return;
            }
            const version = ++resumeListVersion;
            settingsPicker = startTuiSessionPicker(
                [],
                client.agentId,
                true,
            );
            focusActiveSurface();
            renderState();
            void dependencies.listAgents().then((agents) => {
                if (
                    shuttingDown
                    || version !== resumeListVersion
                    || settingsPicker?.kind !== "session"
                ) {
                    return;
                }
                settingsPicker = startTuiSessionPicker(agents, client.agentId);
                focusActiveSurface();
                renderState();
            }).catch((error) => {
                if (
                    !shuttingDown
                    && version === resumeListVersion
                    && settingsPicker?.kind === "session"
                ) {
                    const message = error instanceof Error
                        ? error.message
                        : String(error);
                    state = appendTuiNotice(
                        state,
                        `Could not list sessions: ${message}`,
                    );
                    settingsPicker = undefined;
                    focusActiveSurface();
                    renderState();
                }
            });
            return;
        }
        if (commandAction?.type === "create_session") {
            composer.clearComposer();
            if (dependencies.createSession === undefined) {
                state = appendTuiNotice(
                    state,
                    "Starting a new session is unavailable",
                );
                renderState();
                return;
            }
            if (sessionSwitchPending) {
                return;
            }
            sessionSwitchPending = true;
            sessionSwitchActivity = "starting new session…";
            renderStatus();
            void dependencies.createSession().then((client) => {
                if (shuttingDown) {
                    void client.detach().catch(() => client.close());
                    return;
                }
                nextClient = client;
                renderer.destroy();
            }).catch((error) => {
                if (shuttingDown) {
                    return;
                }
                sessionSwitchPending = false;
                const message = error instanceof Error
                    ? error.message
                    : String(error);
                state = appendTuiNotice(
                    state,
                    `Could not start a new session: ${message}`,
                );
                renderState();
            });
            return;
        }
        if (commandAction?.type === "clone_session") {
            composer.clearComposer();
            if (dependencies.cloneSession === undefined) {
                state = appendTuiNotice(
                    state,
                    "Cloning this session is unavailable",
                );
                renderState();
                return;
            }
            sessionSwitchPending = true;
            sessionSwitchActivity = "cloning session…";
            renderStatus();
            void dependencies.cloneSession().then((client) => {
                if (shuttingDown) {
                    void client.detach().catch(() => client.close());
                    return;
                }
                nextClient = client;
                renderer.destroy();
            }).catch((error) => {
                if (shuttingDown) return;
                sessionSwitchPending = false;
                const message = error instanceof Error
                    ? error.message
                    : String(error);
                state = appendTuiNotice(
                    state,
                    `Could not clone this session: ${message}`,
                );
                renderState();
            });
            return;
        }
        if (commandAction?.type === "update_session_name") {
            const requestId = randomUUID();
            pendingSessionRename = { requestId, commandText: prompt };
            composer.clearComposer();
            void client.send({
                type: "update_session_name",
                requestId,
                name: commandAction.name,
            }).catch((error) => {
                if (pendingSessionRename?.requestId !== requestId) return;
                pendingSessionRename = undefined;
                if (composer.expandedText().length === 0) {
                    composer.setComposerText(prompt);
                }
                reportConnectionError(error);
            });
            showStatusNotice(
                commandAction.name === null
                    ? "clearing session name…"
                    : "renaming session…",
            );
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
        if (commandAction?.type === "open_fork") {
            if (
                state.working
                || state.queuedPrompts.length > 0
                || pendingUiRequest !== undefined
                || timelinePicker !== undefined
            ) {
                state = appendTuiNotice(
                    state,
                    "Fork is available when the agent is idle.",
                );
                renderState();
                return;
            }
            composer.clearComposer();
            applyTimelineTransition(startTuiTimelinePicker(
                randomUUID(),
                "fork",
            ));
            return;
        }

        if (pendingImages.some((image) => image.id === undefined)) {
            submitAfterImageAttachment = true;
            state = appendTuiNotice(state, "Wait for the image attachment to finish.");
            renderState();
            return;
        }
        const attachmentIds = pendingImages.map((image) => image.id!);
        if (attachmentIds.length > 0) {
            const submittedRequestIds = new Set(
                pendingImages.map((image) => image.requestId),
            );
            promptSubmitting = true;
            renderStatus();
            void client.send({
                type: "prompt",
                content: prompt,
                attachmentIds,
            }).then(() => {
                promptSubmitting = false;
                if (shuttingDown) return;
                if (composer.expandedText().trim() === prompt) {
                    composer.rememberSubmittedText(prompt);
                    composer.clearComposer();
                }
                pendingImages = pendingImages.filter(
                    (image) => !submittedRequestIds.has(image.requestId),
                );
                const optimisticText = [
                    prompt,
                    ...attachmentIds.map(() => "[Attached image]"),
                ].filter((part) => part.length > 0).join("\n");
                if (state.entries.at(-1)?.text !== optimisticText) {
                    state = beginTuiTurn(state, prompt, attachmentIds);
                } else if (!state.working) {
                    state = { ...state, working: true };
                }
                workingSince ??= Date.now();
                phaseSince = workingSince;
                activity = "thinking";
                renderState();
            }).catch((error) => {
                promptSubmitting = false;
                reportConnectionError(error);
            });
            return;
        }
        composer.rememberSubmittedText(prompt);
        composer.clearComposer();
        state = state.working
            ? queueTuiPrompt(state, prompt)
            : beginTuiTurn(state, prompt, attachmentIds);
        if (workingSince === undefined) {
            workingSince = Date.now();
            phaseSince = workingSince;
            activity = "thinking";
        }
        renderState();
        pendingImages = [];
        sendCommand({
            type: "prompt",
            content: prompt,
            ...(attachmentIds.length === 0 ? {} : { attachmentIds }),
        });
    }

    function attachPastedImage(path: string): void {
        if (state.working || state.queuedPrompts.length > 0) {
            state = appendTuiNotice(
                state,
                "Images can be attached when the current turn is idle.",
            );
            renderState();
            return;
        }
        const requestId = randomUUID();
        pendingImages.push({ requestId });
        sendCommand({ type: "attach_image", requestId, path });
        showStatusNotice("attaching image…");
    }

    async function receiveAgentUpdates(): Promise<void> {
        try {
            while (!shuttingDown) {
                const update = await client.receive();
                if (shuttingDown) {
                    return;
                }
                if (
                    update.type === "image_attached"
                    || update.type === "image_attachment_rejected"
                ) {
                    const imageIndex = pendingImages.findIndex(
                        (image) => image.requestId === update.requestId,
                    );
                    if (imageIndex === -1) continue;
                    if (update.type === "image_attached") {
                        pendingImages[imageIndex] = {
                            requestId: update.requestId,
                            id: update.attachment.id,
                            name: update.attachment.name,
                        };
                        showStatusNotice(
                            `attached ${update.attachment.name} · ${pendingImages.length} pending`,
                        );
                        if (
                            submitAfterImageAttachment
                            && pendingImages.every((image) => image.id !== undefined)
                        ) {
                            submitAfterImageAttachment = false;
                            queueMicrotask(submitPrompt);
                        }
                    } else {
                        submitAfterImageAttachment = false;
                        pendingImages.splice(imageIndex, 1);
                        state = appendTuiNotice(
                            state,
                            `Could not attach image: ${update.error}`,
                        );
                        renderState();
                    }
                    composer.focus();
                    continue;
                }
                if (
                    update.type === "session_name"
                    || update.type === "session_name_rejected"
                ) {
                    if (update.requestId !== pendingSessionRename?.requestId) {
                        continue;
                    }
                    const pending = pendingSessionRename;
                    pendingSessionRename = undefined;
                    if (update.type === "session_name") {
                        state = appendTuiNotice(
                            state,
                            update.name === null
                                ? "session name cleared"
                                : `session renamed: ${update.name}`,
                        );
                    } else {
                        if (composer.expandedText().length === 0) {
                            composer.setComposerText(pending.commandText);
                        }
                        state = appendTuiNotice(
                            state,
                            update.reason === "invalid"
                                ? "Session name must be 1 to 200 UTF-8 bytes"
                                : "Could not rename this session",
                        );
                    }
                    renderState();
                    composer.focus();
                    continue;
                }
                if (
                    update.type === "ui_request"
                    || update.type === "ui_request_closed"
                ) {
                    if (update.type === "ui_request") {
                        finishThoughtPhase();
                        phaseSince = undefined;
                        activity = update.request.type === "tool_approval"
                            ? "waiting for approval"
                            : "waiting for answer";
                    } else {
                        phaseSince = undefined;
                        activity = "resuming";
                    }
                    const previousRequest = pendingUiRequest;
                    pendingUiRequest = applyTuiUiRequestUpdate(
                        pendingUiRequest,
                        queuedUiRequests,
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
                if (
                    update.type === "model_settings"
                    || update.type === "model_settings_rejected"
                ) {
                    const pending = pendingExtensionSettings.get(
                        update.requestId,
                    );
                    if (pending !== undefined) {
                        pendingExtensionSettings.delete(update.requestId);
                        pending.removeAbortListener();
                        pending.resolve(update.type === "model_settings"
                            ? {
                                status: "accepted",
                                settings: update.settings,
                            }
                            : {
                                status: "rejected",
                                reason: update.reason,
                            });
                    }
                }
                observeActivity(update);
                state = applyAgentUpdate(state, update);
                if (
                    update.type === "model_settings"
                    && state.modelSettings !== undefined
                ) {
                    for (const listener of extensionSettingsListeners) {
                        try {
                            listener(structuredClone(state.modelSettings));
                        } catch {
                            // One extension listener cannot stop client updates.
                        }
                    }
                }
                if (
                    update.type === "model_settings"
                    && settingsPicker?.kind === "model"
                ) {
                    // The same route the permissions list takes below: the
                    // open pane is rebuilt from the snapshot the host sent,
                    // never from a local guess about what the edit did.
                    settingsPicker = syncTuiModelPicker(
                        settingsPicker,
                        state.modelSettings,
                    );
                }
                if (update.type === "permissions" && preferencesList !== undefined) {
                    // How a removal becomes visible: the engine answers with a
                    // full refreshed inspection rather than an acknowledgement,
                    // so the list is never rebuilt from a local guess about
                    // what the removal did.
                    preferencesList = syncTuiPreferencesList(
                        preferencesList,
                        state.permissionInspection,
                    );
                }
                if (update.type === "permissions_rejected" && preferencesList !== undefined) {
                    state = appendTuiNotice(
                        state,
                        update.reason === "unavailable"
                            ? "Removing permissions is unavailable on this host"
                            : "That permission could not be removed",
                    );
                }
                if (update.type === "history") {
                    composer.loadSubmittedTexts(
                        update.entries
                            .filter((entry) => entry.kind === "user")
                            .map((entry) => entry.text),
                    );
                    clearTranscriptNodes();
                }
                if (
                    update.type === "turn_finished"
                    || update.type === "agent_failed"
                ) {
                    abortRequested = false;
                    finishStreamingAssistant();
                    if (update.type === "agent_failed") {
                        pendingUiRequest = undefined;
                        timelinePicker = undefined;
                        settingsPicker = undefined;
                    } else {
                        state = beginNextQueuedTuiTurn(state);
                    }
                    if (state.working) {
                        workingSince = Date.now();
                        phaseSince = workingSince;
                        activity = "thinking";
                    } else {
                        workingSince = undefined;
                        phaseSince = undefined;
                        activity = "ready";
                    }
                }
                renderState();

                if (update.type === "agent_failed") {
                    focusActiveSurface();
                    return;
                }

                if (
                    !state.working
                    && pendingUiRequest === undefined
                    && timelinePicker === undefined
                ) {
                    focusActiveSurface();
                }
            }
        } catch (error) {
            reportConnectionError(error);
        }
    }

    function sendCommand(command: ClientCommand): void {
        void client.send(command).catch(reportConnectionError);
    }

    function requestExtensionModelSettingsUpdate(
        patch: VeraClientModelSettingsPatch,
        signal: AbortSignal,
    ): Promise<VeraClientModelSettingsUpdateResult> {
        if (signal.aborted) {
            return Promise.reject(signal.reason);
        }
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
            const onAbort = (): void => {
                pendingExtensionSettings.delete(requestId);
                reject(signal.reason);
            };
            signal.addEventListener("abort", onAbort, { once: true });
            pendingExtensionSettings.set(requestId, {
                resolve,
                reject,
                removeAbortListener: () =>
                    signal.removeEventListener("abort", onAbort),
            });
            void client.send({
                type: "update_model_settings",
                requestId,
                patch,
            }).catch((error) => {
                pendingExtensionSettings.delete(requestId);
                signal.removeEventListener("abort", onAbort);
                reject(error);
            });
        });
    }

    function requestExtensionPicker(
        request: VeraClientPickerRequest,
        signal: AbortSignal,
    ): Promise<VeraClientPickerResult> {
        if (signal.aborted) {
            return Promise.reject(signal.reason);
        }
        if (pendingExtensionPicker !== undefined || anyOverlayOpen()) {
            return Promise.reject(
                new Error("Another client surface is already open"),
            );
        }
        const supported = new Set(["enter", "s", "delete", "backspace"]);
        const actions: TuiExtensionPickerAction[] = request.actions.flatMap(
            (action) => action.keys.map((key) => {
                if (!supported.has(key)) {
                    throw new Error(
                        `Unsupported extension picker key: ${key}`,
                    );
                }
                return {
                    id: action.id,
                    key: key as TuiExtensionPickerAction["key"],
                    label: action.label,
                };
            }),
        );
        settingsPicker = startTuiExtensionPicker(
            request.title,
            request.rows,
            request.selectedId,
            actions,
        );
        composer.blur();
        renderState();
        focusActiveSurface();
        return new Promise((resolve, reject) => {
            const onAbort = (): void => {
                if (pendingExtensionPicker?.resolve !== resolve) {
                    return;
                }
                pendingExtensionPicker = undefined;
                settingsPicker = undefined;
                focusActiveSurface();
                renderState();
                reject(signal.reason);
            };
            signal.addEventListener("abort", onAbort, { once: true });
            pendingExtensionPicker = {
                resolve,
                reject,
                removeAbortListener: () =>
                    signal.removeEventListener("abort", onAbort),
            };
        });
    }

    async function loadExtensionCommands(): Promise<void> {
        if (client.listExtensionCommands === undefined) {
            return;
        }
        try {
            const commands = await client.listExtensionCommands();
            hostExtensionCommands = commands;
            const commandsBySource = Map.groupBy(
                commands,
                (command) => command.source,
            );
            for (const [source, sourceCommands] of commandsBySource) {
                try {
                    registerExtensionTuiCommands(
                        commandRegistry,
                        sourceCommands,
                    );
                } catch (error) {
                    const message = error instanceof Error
                        ? error.message
                        : String(error);
                    state = appendTuiNotice(
                        state,
                        `${source}: ${message}`,
                    );
                }
            }
            if (commandPalette !== undefined) {
                commandPalette = updateTuiCommandPaletteCommands(
                    commandPalette,
                    registeredPaletteEntries(),
                );
            }
            if (help !== undefined) {
                help = updateTuiHelpCommands(
                    help,
                    coreHelpCommands,
                    hostExtensionCommands,
                );
            }
            renderCommandSuggestions();
            renderState();
        } catch (error) {
            if (shuttingDown) {
                return;
            }
            const message = error instanceof Error
                ? error.message
                : String(error);
            state = appendTuiNotice(
                state,
                `Could not load extension commands: ${message}`,
            );
            renderState();
        } finally {
            extensionCommandsLoading = false;
        }
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
        if (commandPalette !== undefined) {
            commandPaletteView.box.focus();
            return;
        }
        if (help !== undefined) {
            helpView.box.focus();
            return;
        }
        if (confirmingFullAccess) {
            permissionsConfirmView.box.focus();
            return;
        }
        if (sessionTrashCandidate !== undefined) {
            sessionTrashConfirmView.box.focus();
            return;
        }
        if (settingsPicker !== undefined) {
            settingsPickerView.box.focus();
            return;
        }
        if (preferencesList !== undefined) {
            preferencesListView.box.focus();
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
        if (transition.forkBoundaryId !== undefined) {
            beginFork(transition.forkBoundaryId);
            return;
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

    function beginFork(boundaryId: string): void {
        timelinePicker = undefined;
        timelinePickerView.box.visible = false;
        if (dependencies.forkSession === undefined) {
            state = appendTuiNotice(state, "Forking this session is unavailable");
            composer.focus();
            renderState();
            return;
        }
        sessionSwitchPending = true;
        sessionSwitchActivity = "forking session…";
        renderState();
        const fork = dependencies.forkSession(boundaryId);
        let timedOut = false;
        let timeout: ReturnType<typeof setTimeout>;
        const deadline = new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
                timedOut = true;
                reject(new Error("fork timed out"));
            }, dependencies.sessionSwitchTimeoutMs ?? SESSION_SWITCH_TIMEOUT_MS);
        });
        void fork.then((result) => {
            if (timedOut) {
                void result.client.detach().catch(() => result.client.close());
            }
        }, () => undefined);
        void Promise.race([fork, deadline]).then(({ client, prompt }) => {
            clearTimeout(timeout);
            if (shuttingDown) {
                void client.detach().catch(() => client.close());
                return;
            }
            nextClient = client;
            nextDraft = {
                text: prompt.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join(""),
                attachmentIds: prompt.content.flatMap((part) =>
                    part.type === "image_attachment"
                        ? [part.attachmentId]
                        : []
                ),
            };
            renderer.destroy();
        }).catch((error) => {
            clearTimeout(timeout);
            if (shuttingDown) return;
            sessionSwitchPending = false;
            const message = error instanceof Error ? error.message : String(error);
            state = appendTuiNotice(
                state,
                `Could not fork this session: ${message}`,
            );
            composer.focus();
            renderState();
        });
    }

    function reportConnectionError(error: unknown): void {
        if (shuttingDown || connectionFailed) {
            return;
        }
        connectionFailed = true;
        const message = error instanceof Error ? error.message : String(error);
        const interruptedRename = pendingSessionRename;
        pendingSessionRename = undefined;
        if (
            interruptedRename !== undefined
            && composer.expandedText().length === 0
        ) {
            composer.setComposerText(interruptedRename.commandText);
        }
        pendingUiRequest = undefined;
        queuedUiRequests.length = 0;
        timelinePicker = undefined;
        settingsPicker = undefined;
        commandPalette = undefined;
        help = undefined;
        confirmingFullAccess = false;
        sessionTrashCandidate = undefined;
        sessionTrashPending = false;
        abortRequested = false;
        workingSince = undefined;
        phaseSince = undefined;
        activity = "disconnected";
        state = failTuiConnection(state, message);
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
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && settingsPicker !== undefined;
        preferencesListView.box.visible = pendingUiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && settingsPicker === undefined
            && preferencesList !== undefined;
        commandPaletteView.box.visible = pendingUiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && settingsPicker === undefined
            && preferencesList === undefined
            && commandPalette !== undefined;
        helpView.box.visible = pendingUiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && settingsPicker === undefined
            && commandPalette === undefined
            && help !== undefined;
        permissionsConfirmView.box.visible = pendingUiRequest === undefined
            && timelinePicker === undefined
            && sessionTrashCandidate === undefined
            && confirmingFullAccess;
        sessionTrashConfirmView.box.visible = pendingUiRequest === undefined
            && timelinePicker === undefined
            && sessionTrashCandidate !== undefined;
        transcript.opacity = approvalView.box.visible
                || questionView.box.visible
                || timelinePickerView.box.visible
                || settingsPickerView.box.visible
                || commandPaletteView.box.visible
                || helpView.box.visible
                || permissionsConfirmView.box.visible
                || sessionTrashConfirmView.box.visible
            ? 0.35
            : 1;
        composerBox.visible = pendingUiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && settingsPicker === undefined
            && commandPalette === undefined
            && help === undefined;
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
        if (preferencesList !== undefined) {
            preferencesListView.update(preferencesList);
        }
        if (commandPalette !== undefined) {
            commandPaletteView.update(commandPalette);
        }
        if (help !== undefined) {
            helpView.update(help);
        }
        if (sessionTrashCandidate !== undefined) {
            sessionTrashConfirmView.update(sessionTrashCandidate.label);
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
            const markdownNode = entry.kind === "diff"
                ? undefined
                : createTuiMarkdownEntry(
                    renderer,
                    `entry-${index}`,
                    entry,
                    markdownStyle,
                    TUI_TEXT,
                    marginTop,
                );
            const node = entry.kind === "diff"
                ? createTuiDiff(
                    renderer,
                    `entry-${index}`,
                    entry.path,
                    entry.patch,
                    markdownStyle,
                    marginTop,
                )
                : markdownNode ?? new TextRenderable(renderer, {
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

    /**
     * Whether some overlay owns the screen. Bare keybindings and body focus
     * both have to stand down while one is open, and they have to agree on
     * when, so they ask the same question here.
     */
    function anyOverlayOpen(): boolean {
        return pendingUiRequest !== undefined
            || timelinePicker !== undefined
            || settingsPicker !== undefined
            || preferencesList !== undefined
            || commandPalette !== undefined
            || help !== undefined
            || confirmingFullAccess
            || sessionTrashCandidate !== undefined;
    }

    function clearTranscriptNodes(): void {
        while (entryNodes.length > 0) {
            entryNodes.pop()?.destroy();
        }
    }

    // The surface openers below are shared by three callers: a slash command, a
    // palette row, and a /settings menu entry. Keeping them here means the three
    // routes cannot drift into opening the same picker with different arguments.

    function openModelPicker(): void {
        settingsPicker = startTuiSettingsPicker(
            "model",
            state.modelSettings?.model,
            state.modelSettings?.reasoningEffort,
            state.approvalMode,
            state.modelSettings?.availableModels,
            undefined,
            state.modelSettings?.provider,
            undefined,
            state.modelSettings?.stash,
        );
        renderState();
        focusActiveSurface();
    }

    // The current model's own levels, looked up off the wire rather than a
    // flat effort list, so the pane renders exactly what this model offers.
    // A model missing from `availableModels` (unrecognised, e.g. reached
    // through the `/model <name>` escape hatch) is treated the same as a
    // model with an empty `levels` array: no facts about it have reached the
    // client, so there is nothing to render either way.
    function currentModelLevels(): readonly ReasoningLevel[] {
        const models = state.modelSettings?.availableModels ?? [];
        const current = models.find((candidate) =>
            candidate.provider === state.modelSettings?.provider
            && candidate.model === state.modelSettings?.model
        );
        return current?.levels ?? [];
    }

    function openReasoningPicker(): void {
        // An empty (or unresolved) level list means this model has no
        // reasoning control at all. A card with no rows is indistinguishable
        // from the TUI ignoring the key, so say why there is nothing to pick.
        // This is presentation only: the engine still decides what it will
        // accept.
        const levels = currentModelLevels();
        if (levels.length === 0) {
            state = appendTuiNotice(
                state,
                `${state.modelSettings?.model ?? "this model"} has no reasoning effort setting`,
            );
            renderState();
            return;
        }
        const current = state.modelSettings?.availableModels?.find(
            (candidate) =>
                candidate.provider === state.modelSettings?.provider
                && candidate.model === state.modelSettings?.model,
        );
        settingsPicker = startTuiReasoningPicker(
            levels,
            current?.defaultLevel,
            state.modelSettings?.reasoningEffort,
        );
        renderState();
        focusActiveSurface();
    }

    function openPermissionsPicker(): void {
        if (state.permissionInspection !== undefined) {
            state = appendTuiNotice(
                state,
                renderPermissionInspection(state.permissionInspection),
            );
        }
        settingsPicker = startTuiSettingsPicker(
            "permissions",
            state.modelSettings?.model,
            state.modelSettings?.reasoningEffort,
            state.approvalMode,
            state.modelSettings?.availableModels,
            undefined,
            undefined,
            state.permissionInspection?.availableModes,
        );
        renderState();
        focusActiveSurface();
    }

    function openThemePicker(): void {
        settingsPicker = startTuiSettingsPicker(
            "theme",
            state.modelSettings?.model,
            state.modelSettings?.reasoningEffort,
            state.approvalMode,
            state.modelSettings?.availableModels,
            themeName,
        );
        renderState();
        focusActiveSurface();
    }

    function openPreferencesList(): void {
        // Opened from the cached inspection, then refreshed by the reply to
        // this fetch. Without the fetch the list could be stale, since a
        // client is only sent an inspection at startup and when something
        // changes it.
        preferencesList = startTuiPreferencesList(state.permissionInspection);
        sendCommand({ type: "get_permissions", requestId: randomUUID() });
        composer.blur();
        focusActiveSurface();
        renderState();
    }

    function openSettingsMenu(): void {
        settingsPicker = startTuiSettingsMenu("settings");
        composer.blur();
        renderState();
        focusActiveSurface();
    }

    function openSettingsMenuTarget(target: TuiSettingsMenuTarget): void {
        if (target === "model") return openModelPicker();
        if (target === "reasoning") return openReasoningPicker();
        if (target === "theme") return openThemePicker();
        if (target === "permission_mode") return openPermissionsPicker();
        if (target === "granted_permissions") return openPreferencesList();
        settingsPicker = startTuiSettingsMenu("permission_settings");
        renderState();
        focusActiveSurface();
    }

    /**
     * Palette rows run through the composer so a chosen row lands in history and
     * takes the same path a typed command does. Rows with no slash command of
     * their own (and the one row that only starts a command) are dispatched
     * directly instead.
     */
    function runPaletteAction(entry: TuiPaletteEntry): void {
        if (
            entry.action.type === "prefill_composer"
            || entry.slashName === undefined
        ) {
            composer.clearComposer();
            runStandalonePaletteAction(entry.action);
            return;
        }
        composer.setComposerText(`/${entry.slashName}`);
        renderState();
        submitPrompt();
    }

    function runStandalonePaletteAction(action: TuiCommandAction): void {
        if (action.type === "prefill_composer") {
            composer.setComposerText(action.text);
            renderCommandSuggestions();
            renderState();
            composer.focus();
            return;
        }
        if (action.type === "open_model_picker") return openModelPicker();
        if (action.type === "open_reasoning_picker") {
            return openReasoningPicker();
        }
        if (action.type === "open_permissions_picker") {
            return openPermissionsPicker();
        }
        if (action.type === "open_theme_picker") return openThemePicker();
        if (action.type === "open_preferences_list") {
            return openPreferencesList();
        }
        if (action.type === "open_settings_menu") return openSettingsMenu();
        renderState();
        focusActiveSurface();
    }

    function openCommandPalette(): void {
        commandPalette = startTuiCommandPalette(registeredPaletteEntries());
        composer.blur();
        renderState();
        focusActiveSurface();
    }

    function applySettingsPickerTransition(
        transition:
            | TuiSettingsPickerTransition
            | TuiExtensionPickerTransition,
    ): void {
        const extensionPickerWasOpen = settingsPicker?.kind === "extension";
        // Captured before the reassignment below so a model selection that
        // needs to chain into a level pane can hand the model pane back to
        // Escape: `handleTuiSettingsPickerKey` returns no `state` on Enter,
        // so this is the only place that still has it.
        const previousPicker = settingsPicker;
        settingsPicker = transition.state;
        if (
            extensionPickerWasOpen
            && transition.selection?.kind === "extension"
        ) {
            const pending = pendingExtensionPicker;
            pendingExtensionPicker = undefined;
            pending?.removeAbortListener();
            pending?.resolve({
                outcome: "selected",
                rowId: transition.selection.rowId,
                actionId: transition.selection.actionId,
            });
            settingsPickerView.box.visible = false;
            focusActiveSurface();
            renderState();
            return;
        } else if (
            extensionPickerWasOpen
            && transition.state === undefined
            && transition.selection === undefined
        ) {
            const pending = pendingExtensionPicker;
            pendingExtensionPicker = undefined;
            pending?.removeAbortListener();
            pending?.resolve({ outcome: "cancelled" });
            settingsPickerView.box.visible = false;
            focusActiveSurface();
            renderState();
            return;
        }
        if (
            "previewTheme" in transition
            && transition.previewTheme !== undefined
        ) {
            void applySelectedTheme(transition.previewTheme, false);
        }
        if (
            "trashCandidate" in transition
            && transition.trashCandidate !== undefined
        ) {
            sessionTrashCandidate = transition.trashCandidate;
        }
        if ("stashToggle" in transition && transition.stashToggle !== undefined) {
            // The pane stays open and stays on the same row. It is not updated
            // here: the settings snapshot that comes back rebuilds it, so what
            // the user sees is what the host stored rather than a guess.
            sendCommand({
                type: "update_stash",
                requestId: randomUUID(),
                action: transition.stashToggle.action,
                provider: transition.stashToggle.provider,
                model: transition.stashToggle.model,
            });
        }
        if (transition.selection !== undefined) {
            const selection = transition.selection;
            if (selection.kind === "extension") {
                return;
            }
            if (selection.kind === "model") {
                const chosenLevels = selection.reasoningEffort === undefined
                    ? state.modelSettings?.availableModels?.find(
                        (candidate) =>
                            candidate.provider === selection.provider
                            && candidate.model === selection.model,
                    )
                    : undefined;
                if (
                    chosenLevels !== undefined
                    && chosenLevels.levels.length > 0
                    && previousPicker?.kind === "model"
                ) {
                    // A model with levels opens the level pane instead of
                    // closing: Enter there folds both choices into one patch.
                    settingsPicker = startTuiReasoningPicker(
                        chosenLevels.levels,
                        chosenLevels.defaultLevel,
                        state.modelSettings?.reasoningEffort,
                        {
                            provider: selection.provider,
                            model: selection.model,
                            modelPaneState: previousPicker,
                        },
                    );
                    composer.blur();
                    settingsPickerView.update(settingsPicker);
                    settingsPickerView.box.focus();
                    renderState();
                    return;
                }
                sendCommand({
                    type: "update_model_settings",
                    requestId: randomUUID(),
                    patch: {
                        provider: selection.provider,
                        model: selection.model,
                        ...(selection.reasoningEffort === undefined
                            ? {}
                            : { reasoningEffort: selection.reasoningEffort }),
                    },
                });
                state = appendTuiNotice(
                    state,
                    selection.reasoningEffort === undefined
                        ? `model change requested: ${selection.provider}/${selection.model}`
                        : `model change requested: ${selection.provider}/${selection.model} (${selection.reasoningEffort})`,
                );
            } else if (selection.kind === "reasoning") {
                sendCommand({
                    type: "update_model_settings",
                    requestId: randomUUID(),
                    patch: { reasoningEffort: selection.reasoningEffort },
                });
                state = appendTuiNotice(state, `reasoning change requested: ${selection.reasoningEffort}`);
            } else if (selection.kind === "permissions") {
                if (selection.mode === "full_access") {
                    confirmingFullAccess = true;
                } else {
                    requestPermissionsChange(selection.mode);
                }
            } else if (selection.kind === "theme") {
                themeName = selection.theme;
                saveTuiThemePreference(themeName);
                void applySelectedTheme(themeName, true);
            } else if (selection.kind === "menu") {
                // A menu row opens the next surface, which replaces this one.
                settingsPicker = undefined;
                openSettingsMenuTarget(selection.target);
                return;
            } else {
                resumeSessionPath = selection.sessionPath;
                renderer.destroy();
                return;
            }
            settingsPicker = undefined;
        }
        if (sessionTrashCandidate !== undefined) {
            composer.blur();
            sessionTrashConfirmView.update(sessionTrashCandidate.label);
            sessionTrashConfirmView.box.focus();
        } else if (settingsPicker === undefined) {
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

    function beginSessionTrash(candidate: {
        readonly sessionId: string;
        readonly label: string;
    }): void {
        if (dependencies.trashSession === undefined) {
            sessionTrashCandidate = undefined;
            state = appendTuiNotice(
                state,
                "Moving conversations to Trash is unavailable",
            );
            renderState();
            return;
        }
        sessionTrashPending = true;
        sessionSwitchPending = true;
        sessionSwitchActivity = "moving conversation to Trash…";
        renderState();
        void performSessionTrash(candidate);
    }

    async function performSessionTrash(candidate: {
        readonly sessionId: string;
        readonly label: string;
    }): Promise<void> {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await Promise.race([
                dependencies.trashSession!(candidate.sessionId),
                new Promise<TrashSessionResult>((resolve) => {
                    timeout = setTimeout(() => {
                        resolve({ status: "rejected", reason: "failed" });
                    }, dependencies.sessionSwitchTimeoutMs
                        ?? SESSION_SWITCH_TIMEOUT_MS);
                }),
            ]);
            clearTimeout(timeout);
            if (shuttingDown) return;
            if (result.status === "trashed") {
                state = appendTuiNotice(
                    state,
                    `moved to Trash: ${candidate.label}`,
                );
                if (dependencies.listAgents !== undefined) {
                    try {
                        settingsPicker = startTuiSessionPicker(
                            await dependencies.listAgents(),
                            client.agentId,
                        );
                    } catch {
                        settingsPicker = removeSessionPickerOption(
                            settingsPicker?.kind === "extension"
                                ? undefined
                                : settingsPicker,
                            candidate.sessionId,
                        );
                    }
                }
            } else {
                state = appendTuiNotice(
                    state,
                    result.reason === "busy"
                        ? "That conversation is active in another client"
                        : result.reason === "not_found"
                        ? "That conversation is no longer available"
                        : "Could not move that conversation to Trash",
                );
            }
        } catch {
            clearTimeout(timeout);
            if (shuttingDown) return;
            sessionTrashPending = false;
            sessionSwitchPending = false;
            sessionTrashCandidate = undefined;
            state = appendTuiNotice(
                state,
                    "Could not move that conversation to Trash",
                );
            }
            sessionTrashPending = false;
            sessionSwitchPending = false;
            sessionTrashCandidate = undefined;
        focusActiveSurface();
        renderState();
    }

    function requestPermissionsChange(mode: string): void {
        sendCommand({
            type: "update_permissions",
            requestId: randomUUID(),
            mode,
        });
        state = appendTuiNotice(state, `permissions change requested: ${mode}`);
    }

    async function applySelectedTheme(
        selectedTheme: typeof themeName,
        announce: boolean,
    ): Promise<void> {
        const version = ++themeApplicationVersion;
        const resolvedTheme = await resolveTuiTheme(renderer, selectedTheme);
        if (version !== themeApplicationVersion || shuttingDown) {
            return;
        }
        theme = resolvedTheme;
        applyTuiTheme(theme);
        renderer.setBackgroundColor(theme.background);
        clearTranscriptNodes();
        markdownStyle.destroy();
        markdownStyle = createMarkdownStyle(theme);

        placeholder.fg = theme.muted;
        statusText.bg = theme.background;
        backgroundStatusText.bg = theme.background;
        backgroundStatusText.fg = theme.muted;
        queuedPromptText.fg = theme.muted;
        commandSuggestionsText.fg = theme.text;
        composerBox.backgroundColor = theme.panel;
        composerBox.borderColor = theme.accent;
        composer.backgroundColor = theme.panel;
        composer.focusedBackgroundColor = theme.panel;
        composer.textColor = theme.text;
        composer.focusedTextColor = theme.text;
        composer.cursorColor = theme.accent;
        approvalView.box.backgroundColor = theme.panel;
        approvalView.detailsText.fg = theme.text;
        questionView.box.backgroundColor = theme.panel;
        questionView.detailsText.fg = theme.text;
        questionView.choiceAction.fg = theme.muted;
        questionView.cancelAction.fg = theme.muted;
        timelinePickerView.box.backgroundColor = theme.panel;
        if (timelinePicker !== undefined) {
            timelinePickerView.update(timelinePicker);
        }
        settingsPickerView.box.backgroundColor = theme.panel;
        commandPaletteView.box.backgroundColor = theme.panel;
        helpView.box.backgroundColor = theme.panel;

        if (announce) {
            state = appendTuiNotice(state, `theme changed: ${selectedTheme}`);
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
        // commands appear to be missing. Borderless now, so no frame rows to add.
        commandSuggestionsBox.height = suggestions.length > 0
            ? suggestions.length
            : 1;
        commandSuggestionsBox.visible = suggestions.length > 0
            && pendingUiRequest === undefined
            && timelinePicker === undefined
            && settingsPicker === undefined
            && commandPalette === undefined
            && help === undefined;
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

    return finished.promise;

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
        if (connectionFailed) {
            lifecycleHint = "disconnected · /resume reconnect · ctrl+c quit";
        } else if (abortRequested) {
            lifecycleHint = `${STOPPING_HINT} · ${elapsedWorkingTime()}`;
        } else if (
            pendingUiRequest !== undefined
            && isToolApprovalUiRequestUpdate(pendingUiRequest)
        ) {
            lifecycleHint = tuiApprovalHint(pendingUiRequest);
        } else if (pendingUiRequest?.request.type === "user_question") {
            lifecycleHint = `${QUESTION_HINT} · ${elapsedWorkingTime()}`;
        } else if (state.working) {
            lifecycleHint = `${activity} · ${elapsedWorkingTime()} · ${WORKING_HINT}`;
        } else if (pendingImages.some((image) => image.id === undefined)) {
            lifecycleHint = "attaching image…";
        } else if (promptSubmitting) {
            lifecycleHint = "sending prompt with image…";
        } else if (sessionSwitchPending) {
            lifecycleHint = sessionSwitchActivity;
        } else if (extensionCommandPending) {
            lifecycleHint =
                `${extensionCommandActivity ?? "running extension command"} · ctrl+c quit`;
        } else if (pendingImages.length > 0) {
            lifecycleHint = `${pendingImages.length} image${pendingImages.length === 1 ? "" : "s"} attached · enter send`;
        }

        statusText.fg = state.approvalMode === "full_access"
            ? "#ff3b30"
            : statusNotice !== undefined
            ? TUI_NOTICE
            : state.working
                    || pendingUiRequest !== undefined
                    || extensionCommandPending
                ? TUI_ACCENT
                : TUI_MUTED;
        const statusLine = statusNotice ?? lifecycleHint;
        backgroundStatusText.content = renderTuiStatusDetailsLine(
            state.modelSettings,
            state.approvalMode,
            state.contextInputTokens,
            process.cwd(),
            runningBackgroundAgents,
        );
        statusText.content = state.working
                && statusNotice === undefined
                && pendingUiRequest === undefined
                && !abortRequested
            ? renderTuiActivityAnimation(
                activityAnimation,
                activityFrame(),
                statusLine,
                {
                    active: TUI_ACCENT,
                    // The trail is part of Vera's ActiveGrid identity, not a
                    // success indicator inherited from the selected theme.
                    trail: VERA_TUI_THEME.success,
                    inactive: TUI_MUTED,
                    text: state.approvalMode === "full_access"
                        ? "#ff3b30"
                        : TUI_ACCENT,
                },
                activityAnimationWidth,
            )
            : statusLine;
    }

    async function refreshBackgroundAgentCount(): Promise<void> {
        if (
            dependencies.getRunningBackgroundAgentCount === undefined
            || backgroundAgentRefreshPending
            || shuttingDown
        ) {
            return;
        }
        backgroundAgentRefreshPending = true;
        try {
            const nextCount =
                await dependencies.getRunningBackgroundAgentCount();
            if (!shuttingDown && nextCount !== runningBackgroundAgents) {
                runningBackgroundAgents = nextCount;
                renderStatus();
            }
        } catch {
            if (!shuttingDown && runningBackgroundAgents !== 0) {
                runningBackgroundAgents = 0;
                renderStatus();
            }
        } finally {
            backgroundAgentRefreshPending = false;
        }
    }

    function observeActivity(update: AgentUpdate): void {
        if (update.type === "user_prompt") {
            workingSince ??= Date.now();
            phaseSince = Date.now();
            activity = "thinking";
        } else if (update.type === "assistant_delta") {
            finishThoughtPhase();
            workingSince ??= Date.now();
            activity = "responding";
        } else if (update.type === "tool_started") {
            finishThoughtPhase();
            workingSince ??= Date.now();
            activity = `running ${update.tool}`;
        } else if (update.type === "tool_finished") {
            activity = "thinking";
            phaseSince = Date.now();
        } else if (
            update.type === "turn_finished"
            || update.type === "agent_failed"
        ) {
            finishThoughtPhase();
        }
    }

    function finishThoughtPhase(): void {
        if (activity !== "thinking" || phaseSince === undefined) {
            return;
        }
        const seconds = Math.max(0, Date.now() - phaseSince) / 1_000;
        state = appendTuiThought(state, seconds);
        phaseSince = undefined;
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

    function activityFrame(): number {
        const interval = activityAnimationInterval
            ?? (activityAnimation === "symmetric_wave"
                ? SYMMETRIC_WAVE_FRAME_INTERVAL_MS
                : DEFAULT_ACTIVITY_FRAME_INTERVAL_MS);
        return Math.floor(Date.now() / interval);
    }

}
