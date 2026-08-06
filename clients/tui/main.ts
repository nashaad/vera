import {
    BoxRenderable,
    CliRenderEvents,
    decodePasteBytes,
    fg,
    MarkdownRenderable,
    ScrollBoxRenderable,
    stripAnsiSequences,
    SyntaxStyle,
    StyledText,
    TextRenderable,
    createCliRenderer,
    KeyEvent,
    type Selection,
} from "@opentui/core";
import { randomUUID } from "node:crypto";

import type { DialogRowPointer } from "./dialog-chrome.ts";

import {
    isToolApprovalUiRequestUpdate,
    isTimelineReplyUpdate,
    isUserQuestionUiRequestUpdate,
    type AgentUpdate,
    type ClientCommand,
    type UiRequestUpdate,
} from "../../src/engine/protocol.ts";
import type { ModelSettingsPatch } from "../../src/engine/model-settings.ts";
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
import {
    renameSessionThroughHost,
    type RenameSessionResult,
} from "../../src/host/session-rename-client.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import {
    findOrStartResidentHost,
    hostEntrypointMismatchNotice,
} from "../host/launch.ts";
import {
    createTuiApprovalView,
    tuiApprovalHint,
} from "./approval.ts";
import {
    createTuiQuestionView,
} from "./question.ts";
import { applyTuiUiRequestUpdate } from "./ui-request-queue.ts";
import { renderTuiDiagnostics } from "./diagnostics.ts";
import {
    defaultStashRoot,
    summarizeStash,
} from "../../src/store/preimage-stash.ts";
import { copyTuiText, countTuiCharacters } from "./clipboard.ts";
import {
    createTuiCommandPaletteView,
    handleTuiCommandPaletteKey,
    handleTuiCommandPaletteScroll,
    startTuiCommandPalette,
    updateTuiCommandPaletteCommands,
    type TuiCommandPaletteState,
} from "./command-palette.ts";
import {
    createTuiHelpView,
    handleTuiHelpKey,
    handleTuiHelpScroll,
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
    renderBackgroundAgentNames,
    renderTuiStatusDetailsLine,
} from "./status.ts";
import {
    createTuiSettingsPickerView,
    handleTuiSettingsPickerScroll,
    handleTuiSettingsPickerKey,
    tuiPickerViewportRows,
    startTuiSettingsMenu,
    startTuiSettingsPicker,
    syncTuiModelPicker,
    startTuiReasoningPicker,
    startTuiSessionPicker,
    startTuiExtensionPicker,
    startTuiProviderPicker,
    tuiPickerMenuAncestor,
    withTuiPickerParent,
    type TuiTopPickRow,
    type TuiSettingsMenuTarget,
    type TuiAnySettingsPickerState,
    type TuiSettingsPickerState,
    type TuiSettingsPickerTransition,
    type TuiExtensionPickerAction,
    type TuiExtensionPickerTransition,
} from "./settings-picker.ts";
import { loadTopPicks, type TopPick } from "../../src/model/top-picks.ts";
import {
    createTuiSecretPromptView,
    handleTuiSecretPromptKey,
    handleTuiSecretPromptPaste,
    startTuiSecretPrompt,
    type TuiSecretPromptState,
} from "./secret-prompt.ts";
import {
    createTuiSessionRenamePromptView,
    handleTuiSessionRenamePromptKey,
    handleTuiSessionRenamePromptPaste,
    startTuiSessionRenamePrompt,
    type TuiSessionRenamePromptState,
    type TuiSessionRenamePromptTransition,
} from "./session-rename-prompt.ts";
import {
    tuiBindingId,
    tuiChord,
    tuiChordOwner,
    tuiKeyHint,
} from "./keymap.ts";
import {
    createAuthStorage,
    unreadableAuthStoragePath,
    type AuthStorage,
} from "../../src/providers/auth-storage.ts";
import {
    findProvider,
    isProviderConnected,
    PROVIDERS,
} from "../../src/providers/registry.ts";
import { loginOpenAICodex } from "../../src/providers/openai-codex-oauth.ts";
import { renderPermissionInspection } from "./permission-inspection.ts";
import {
    createTuiPreferencesListView,
    handleTuiPreferencesListKey,
    handleTuiPreferencesListScroll,
    startTuiPreferencesList,
    syncTuiPreferencesList,
    type TuiPreferencesListState,
} from "./preferences-list.ts";
import {
    renderResumeHint,
    resolveResumeTarget,
    resolveContinueTarget,
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
    TUI_ELEMENT,
    TUI_MUTED,
    TUI_NOTICE,
    TUI_TEXT,
    applyTuiTheme,
    appendTuiNotice,
    appendTuiThought,
    dropTuiThinking,
    toggleTuiThinking,
    applyAgentUpdate,
    userEntryShows,
    beginNextQueuedTuiTurn,
    beginTuiTurn,
    createTuiState,
    failTuiConnection,
    queueTuiPrompt,
    renderTuiEntry,
    renderTuiQueuedPrompt,
    setTuiWorkspaceRoot,
    tuiDisplayPath,
    tuiEntryMarginTop,
} from "./state.ts";
import { resolveTuiTheme, VERA_TUI_THEME } from "./theme.ts";
import {
    loadTuiActivityAnimationPreference,
    loadTuiActivityAnimationIntervalPreference,
    loadTuiActivityAnimationWidthPreference,
    loadTuiRecentSessionId,
    loadTuiThemePreference,
    loadTuiExtensionPreference,
    deleteTuiExtensionPreference,
    saveTuiExtensionPreference,
    saveTuiRecentSessionId,
    saveTuiThemePreference,
} from "./theme-preference.ts";
import { createTuiDiff } from "./diff.ts";
import { createTuiUserEntry } from "./user-entry.ts";
import { createTuiToolRow, updateTuiToolRow } from "./tool-row.ts";
import { createTuiMarkdownEntry } from "./markdown-entry.ts";

// The palette has no other advertisement: it is a chord, not a slash command in
// the composer's list, so the idle status line is where you find out it exists.
const READY_HINT = `ready · ${tuiKeyHint("open_palette")}`;
const WORKING_HINT = `enter queue · esc redirect/stop · ${tuiKeyHint("interrupt")}`;
const STOPPING_HINT = "stopping…";
// The question overlay owns the choose/cancel hint now, so the status line only
// carries the waiting phase and the global interrupt.
const QUESTION_HINT = `question waiting · ${tuiKeyHint("interrupt")}`;
const COPY_NOTICE_DURATION_MS = 1_500;
const STATUS_REFRESH_INTERVAL_MS = 100;
const BACKGROUND_AGENT_REFRESH_INTERVAL_MS = 1_000;
const DIRECT_EXTENSION_COMMAND_TIMEOUT_MS = 2_000;
const SYMMETRIC_WAVE_FRAME_INTERVAL_MS = 360;
const DEFAULT_ACTIVITY_FRAME_INTERVAL_MS = 160;
const SESSION_SWITCH_TIMEOUT_MS = 15_000;

function truncateFooterLine(text: string, width: number): string {
    const characters = Array.from(text);
    const limit = Math.max(1, width);
    return characters.length <= limit
        ? text
        : `${characters.slice(0, limit - 1).join("").trimEnd()}…`;
}

export interface TuiDependencies {
    readonly client: TuiAgentClient;
    readonly copyText?: (text: string) => Promise<void>;
    readonly listAgents?: () => Promise<readonly RegisteredAgentSummary[]>;
    readonly getRunningBackgroundAgentCount?: () => Promise<number>;
    /**
     * The four ways to reach another session, each handed the identity of the
     * one being left rather than closing over it.
     *
     * They used to read the current client from the scope that started the TUI,
     * which was true exactly once: after the first switch that binding pointed
     * at a session the user had already left, and cloning would have cloned it.
     */
    readonly createSession?: (workspace: string) => Promise<TuiAgentClient>;
    readonly cloneSession?: (agentId: string) => Promise<TuiAgentClient>;
    readonly forkSession?: (
        agentId: string,
        boundaryId: string,
    ) => Promise<{ readonly client: TuiAgentClient; readonly prompt: UserMessage }>;
    readonly resumeSession?: (sessionPath: string) => Promise<TuiAgentClient>;
    readonly reconnectSession?: (agentId: string) => Promise<TuiAgentClient>;
    readonly onSessionEntered?: (agentId: string) => void;
    readonly initialDraft?: TuiDraft;
    /** Notice lines shown in the transcript before anything else happens. */
    readonly startupNotices?: readonly string[];
    readonly sessionSwitchTimeoutMs?: number;
    readonly trashSession?: (sessionId: string) => Promise<TrashSessionResult>;
    readonly renameSession?: (
        sessionId: string,
        name: string | null,
    ) => Promise<RenameSessionResult>;
    readonly disabledBuiltinExtensions?: readonly string[];
    readonly clientExtensions?: readonly VeraExtensionConfig[];
    /** Overrides `~/.vera/auth.json`, so a test never reads real credentials. */
    readonly authStorage?: AuthStorage;
    /** Overrides the browser hand-off a provider's OAuth row would run. */
    readonly loginProvider?: (
        providerId: string,
        onAuthorizationUrl: (url: string) => void,
    ) => Promise<void>;
}

export interface TuiDraft {
    readonly text: string;
    readonly attachmentIds: readonly string[];
}

/**
 * What the TUI reports when it closes.
 *
 * Empty, and deliberately still a type: switching sessions used to end the TUI
 * and ask the caller to start another one against the session that was picked,
 * so this carried the handover. The host is resident and already holds every
 * session, so a switch is a detach and an attach with the renderer left alone,
 * and there is nothing left to hand over.
 */
export interface TuiExit {
    /** The session attached when the TUI closed, for a caller that logs it. */
    readonly agentId?: string;
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
    let host = await findOrStartResidentHost({
        ...(options.confirmBusyUpgrade === undefined
            ? {}
            : { confirmBusyUpgrade: options.confirmBusyUpgrade }),
    });
    const resolvedTarget = target.type === "continue"
        ? resolveContinueTarget(
            await listAgentsThroughHost(host.socket_path),
            loadTuiRecentSessionId(),
        )
        : target.type === "resume"
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
    const client = await attachAgent({
        socketPath: host.socket_path,
        agentId,
    });
    const rememberSession = (enteredAgentId: string): void => {
        saveTuiRecentSessionId(enteredAgentId);
    };
    try {
        rememberSession(agentId);
    } catch (error) {
        process.stderr.write(`${recentSessionSaveFailure(error)}\n`);
    }
    // One call, not a loop: the TUI attaches to whatever session the user moves
    // to without closing, so there is no longer a "start me again against this
    // other session" answer for a caller to act on.
    const attach = (id: string) =>
        attachAgent({ socketPath: host.socket_path, agentId: id });
    try {
        const listAgents = () => listAgentsThroughHost(host.socket_path);
        const mismatchNotice = hostEntrypointMismatchNotice(host);
        const exit = await startTui({
            client,
            ...(mismatchNotice === undefined
                ? {}
                : { startupNotices: [mismatchNotice] }),
            listAgents,
            getRunningBackgroundAgentCount: async () =>
                countRunningBackgroundAgents(await listAgents()),
            createSession: async (workspace) =>
                attach((await createAgentThroughHost(host.socket_path, workspace)).id),
            cloneSession: async (currentAgentId) =>
                attach(
                    (await branchAgentThroughHost(
                        host.socket_path,
                        currentAgentId,
                        "at",
                    )).id,
                ),
            forkSession: async (currentAgentId, boundaryId) => {
                const ready = await branchAgentThroughHost(
                    host.socket_path,
                    currentAgentId,
                    "before",
                    boundaryId,
                );
                if (ready.prompt === undefined) {
                    throw new Error("Host did not return the fork prompt");
                }
                return { client: await attach(ready.id), prompt: ready.prompt };
            },
            resumeSession: async (sessionPath) =>
                attach(
                    (await resumeAgentThroughHost(host.socket_path, sessionPath)).id,
                ),
            reconnectSession: async (currentAgentId) => {
                host = await findOrStartResidentHost({
                    ...(options.confirmBusyUpgrade === undefined
                        ? {}
                        : { confirmBusyUpgrade: options.confirmBusyUpgrade }),
                });
                return attach(currentAgentId);
            },
            onSessionEntered: rememberSession,
            trashSession: (sessionId) =>
                trashSessionThroughHost(host.socket_path, sessionId),
            renameSession: (sessionId, name) =>
                renameSessionThroughHost(host.socket_path, sessionId, name),
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
        process.stdout.write(renderResumeHint(exit.agentId));
    } catch (error) {
        client.close();
        throw error;
    }
}

export async function startTui(
    dependencies: TuiDependencies,
): Promise<TuiExit> {
    /**
     * The session currently on screen.
     *
     * Reassigned by switchToClient rather than fixed for the life of the TUI:
     * moving to another session is a detach and an attach, and everything that
     * talks to the host reads this binding at the moment it sends.
     */
    let client = dependencies.client;
    setTuiWorkspaceRoot(client.workspace ?? process.cwd());
    const renderer = await createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 30,
    });
    const copyText = dependencies.copyText
        ?? ((text: string) => copyTuiText(text, renderer));
    let sessionTitle: string | undefined;
    applyTerminalTitle();
    refreshTerminalTitle();
    let themeName = loadTuiThemePreference();
    let activityAnimation = loadTuiActivityAnimationPreference();
    const activityAnimationInterval =
        loadTuiActivityAnimationIntervalPreference();
    const activityAnimationWidth = loadTuiActivityAnimationWidthPreference();
    let theme = await resolveTuiTheme(renderer, themeName);
    applyTuiTheme(theme);

    let state = createTuiState();
    for (const notice of dependencies.startupNotices ?? []) {
        state = appendTuiNotice(state, notice);
    }
    let connectionFailed = false;
    let statusNotice: string | undefined;
    let statusNoticeVersion = 0;
    // What each in-flight change asked for, so a rejection can name it. The
    // status line reports the effective values once a change lands.
    const requestedModelChanges = new Map<string, string>();
    const requestedPermissionChanges = new Map<string, string>();
    let shuttingDown = false;
    let abortRequested = false;

    function applyTerminalTitle(): void {
        renderer.setTerminalTitle(
            sessionTitle === undefined || sessionTitle.length === 0
                ? "Vera"
                : `${sessionTitle} · Vera`,
        );
    }

    function fallbackSessionTitle(text: string): string | undefined {
        const title = text.replaceAll(/\s+/g, " ").trim().slice(0, 80);
        return title.length === 0 ? undefined : title;
    }

    function adoptFallbackSessionTitle(text: string): void {
        if (sessionTitle !== undefined) {
            return;
        }
        const title = fallbackSessionTitle(text);
        if (title === undefined) {
            return;
        }
        sessionTitle = title;
        applyTerminalTitle();
    }

    function refreshTerminalTitle(): void {
        const agentId = client.agentId;
        if (agentId === undefined || dependencies.listAgents === undefined) {
            return;
        }
        void dependencies.listAgents().then((agents) => {
            if (shuttingDown || agentId !== client.agentId) {
                return;
            }
            sessionTitle = agents.find((agent) => agent.id === agentId)?.title;
            applyTerminalTitle();
        }).catch(() => {
            // The title keeps its last value when the host cannot be reached.
        });
    }
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
    let secretPrompt: TuiSecretPromptState | undefined;
    let sessionRenamePrompt: TuiSessionRenamePromptState | undefined;
    let preferencesList: TuiPreferencesListState | undefined;
    /** The picker pane the preferences list was opened over, restored on close. */
    let preferencesListParent: TuiSettingsPickerState | undefined;
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
    /**
     * Bumped by every switch, so the update pump reading the session being left
     * can tell that it is stale and stop instead of writing that session's
     * updates into the transcript of the one now on screen.
     */
    let clientGeneration = 0;
    let resumeListVersion = 0;
    let promptSubmitting = false;
    let sessionSwitchPending = false;
    let sessionSwitchActivity = "starting new session…";
    let extensionCommandPending = false;
    let extensionCommandActivity: string | undefined;
    let extensionCommandsLoading =
        dependencies.client.listExtensionCommands !== undefined;
    let runningBackgroundAgents = 0;
    let runningBackgroundAgentNames = "";
    let currentAgentHasParent = false;
    let backgroundAgentRefreshPending = false;
    let pendingSessionRename: {
        readonly requestId: string;
        /** Restored to the composer if the rename never lands, when it came from one. */
        readonly commandText?: string;
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
    // An extension chord that a built-in already owns never fires: the global
    // handler and every overlay read the keymap before the registry is
    // consulted. Losing that race silently is the thing the keymap exists to
    // stop, so it is said out loud where the user can see it.
    for (const binding of clientExtensionRegistry.keybindings()) {
        for (const key of binding.keys) {
            const owner = tuiChordOwner(key);
            if (owner !== undefined && owner.extensionId !== binding.id) {
                state = appendTuiNotice(
                    state,
                    `${binding.id} cannot use ${key}: Vera already uses it to ${owner.description.toLowerCase()}`,
                );
            }
        }
    }
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
    composer.onImageChipRemoved = (requestId) => {
        pendingImages = pendingImages.filter(
            (image) => image.requestId !== requestId,
        );
        if (pendingImages.length === 0) {
            submitAfterImageAttachment = false;
        }
        renderState();
    };
    if (dependencies.initialDraft !== undefined) {
        composer.setComposerText(dependencies.initialDraft.text);
        for (const image of pendingImages) {
            composer.attachImageChip(image.requestId);
        }
    }
    const timelinePickerView = createTuiTimelinePickerView(renderer);
    const settingsPickerView = createTuiSettingsPickerView(renderer);
    const secretPromptView = createTuiSecretPromptView(renderer);
    const sessionRenamePromptView = createTuiSessionRenamePromptView(renderer);
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
    // Clicking a row is the pointer's version of ⏎ on it, and hovering is the
    // pointer's version of ↑↓. Each surface only says where its cursor lives;
    // `rowPointer` supplies the behaviour, so the two input paths cannot drift.
    //
    // The wheel is a third path and a separate one: it is bound per overlay
    // below, and it moves the cursor without activating anything. All three end
    // up at the same cursor, so a change to what a row means has to be made in
    // the surface's key handler, which is the only place all three meet.
    timelinePickerView.pointer = rowPointer((index) => {
        if (timelinePicker === undefined) return;
        // The rewind flow reuses one overlay for two lists. On the action
        // screen the rows are the actions themselves, so there is no cursor to
        // move first; the digit press below carries the choice.
        if (timelinePicker.screen !== "select") return;
        timelinePicker = { ...timelinePicker, selectedIndex: index };
    });
    settingsPickerView.pointer = rowPointer((index) => {
        if (settingsPicker === undefined) return;
        settingsPicker = { ...settingsPicker, selectedIndex: index };
    });
    preferencesListView.pointer = rowPointer((index) => {
        if (preferencesList === undefined) return;
        preferencesList = { ...preferencesList, selectedIndex: index };
    });
    commandPaletteView.pointer = rowPointer((index) => {
        if (commandPalette === undefined) return;
        commandPalette = { ...commandPalette, selectedIndex: index };
    });
    helpView.pointer = rowPointer((index) => {
        if (help === undefined) return;
        help = { ...help, selectedIndex: index };
    });
    // The approval and question dialogs are answered by number, not by a
    // moving highlight, so a click sends the row's own digit.
    approvalView.pointer = rowPointer(() => {}, "digit");
    questionView.pointer = rowPointer(() => {}, "digit");
    // The pane windows itself around the cursor, so the wheel moves the cursor
    // and lets the window follow, the same way ctrl+d and ctrl+u do.
    settingsPickerView.box.onMouseScroll = (event) => {
        const scroll = event.scroll;
        if (settingsPicker === undefined || scroll === undefined) return;
        const transition = handleTuiSettingsPickerScroll(settingsPicker, scroll);
        if (!transition.handled) return;
        event.preventDefault();
        event.stopPropagation();
        applySettingsPickerTransition(transition);
    };
    app.add(settingsPickerView.box);
    app.add(secretPromptView.box);
    app.add(sessionRenamePromptView.box);
    // Every windowed overlay takes the wheel, not just the one it was built for
    // first. The handlers are the same three lines because the movement itself
    // lives in list-window.ts.
    preferencesListView.box.onMouseScroll = (event) => {
        if (preferencesList === undefined || event.scroll === undefined) return;
        const transition = handleTuiPreferencesListScroll(
            preferencesList,
            event.scroll,
        );
        if (!transition.handled) return;
        event.preventDefault();
        event.stopPropagation();
        preferencesList = transition.state;
        renderState();
    };
    commandPaletteView.box.onMouseScroll = (event) => {
        if (commandPalette === undefined || event.scroll === undefined) return;
        const transition = handleTuiCommandPaletteScroll(
            commandPalette,
            event.scroll,
        );
        if (!transition.handled) return;
        event.preventDefault();
        event.stopPropagation();
        commandPalette = transition.state;
        renderState();
    };
    helpView.box.onMouseScroll = (event) => {
        if (help === undefined || event.scroll === undefined) return;
        const transition = handleTuiHelpScroll(help, event.scroll);
        if (!transition.handled) return;
        event.preventDefault();
        event.stopPropagation();
        help = transition.state;
        renderState();
    };
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
                finished.resolve(
                    client.agentId === undefined
                        ? {}
                        : { agentId: client.agentId },
                );
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

    // The composer takes pastes through its own renderable handler, but the
    // secret prompt is a plain box drawn over whatever is behind it, so the
    // paste has to be routed here. Ahead of the composer, which would otherwise
    // end up with the key as visible text in the transcript.
    renderer.keyInput.on("paste", (event) => {
        if (
            sessionRenamePrompt !== undefined
            && sessionRenamePromptView.box.visible
        ) {
            event.preventDefault();
            event.stopPropagation();
            sessionRenamePrompt = handleTuiSessionRenamePromptPaste(
                sessionRenamePrompt,
                stripAnsiSequences(decodePasteBytes(event.bytes)),
            );
            renderState();
            return;
        }
        if (secretPrompt === undefined) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        secretPrompt = handleTuiSecretPromptPaste(
            secretPrompt,
            stripAnsiSequences(decodePasteBytes(event.bytes)),
        );
        renderState();
    });

    renderer.keyInput.on("keypress", handleKeypress);

    /**
     * Every key the TUI acts on arrives here, overlays included. Pointer input
     * is routed back through it (see `pressKey`) rather than growing a second
     * decision path per overlay: a click on a row has to mean exactly what ⏎ on
     * that row means, and the only way to guarantee that is for it to be the
     * same call.
     */
    function handleKeypress(key: KeyEvent): void {
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
            if (
                pendingUiRequest === undefined && !sessionSwitchPending
                && secretPrompt === undefined
                && sessionRenamePrompt === undefined
            ) {
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
            !composer.focused
            && activeOverlayFocus() === undefined
            && tuiBindingId("unfocused", key) === "focus_composer"
        ) {
            key.preventDefault();
            key.stopPropagation();
            composer.focus();
            renderState();
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
        } else if (
            pendingUiRequest !== undefined
            && isToolApprovalUiRequestUpdate(pendingUiRequest)
        ) {
            // ←/→ move the button highlight (no engine message); digits, Enter,
            // and Escape resolve the approval. Selection stays client-local.
            const result = approvalView.handleKey(pendingUiRequest, key);
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

        // Ahead of the picker: the prompt is drawn over the pane that opened
        // it, so it takes the keys while it is up.
        if (sessionRenamePrompt !== undefined) {
            const transition = handleTuiSessionRenamePromptKey(
                sessionRenamePrompt,
                key,
            );
            if (transition.handled) {
                key.preventDefault();
                key.stopPropagation();
                applySessionRenamePromptTransition(
                    sessionRenamePrompt,
                    transition,
                );
                return;
            }
        }

        if (secretPrompt !== undefined) {
            const transition = handleTuiSecretPromptKey(secretPrompt, key);
            if (transition.handled) {
                key.preventDefault();
                key.stopPropagation();
                applySecretPromptTransition(secretPrompt, transition);
                return;
            }
        }

        if (settingsPicker !== undefined) {
            const viewportRows = tuiPickerViewportRows(renderer, settingsPicker);
            const transition = settingsPicker.kind === "extension"
                ? handleTuiSettingsPickerKey(settingsPicker, key, viewportRows)
                : handleTuiSettingsPickerKey(settingsPicker, key, viewportRows);
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
                    settingsPicker = preferencesListParent;
                    preferencesListParent = undefined;
                    if (settingsPicker === undefined) {
                        composer.focus();
                    } else {
                        settingsPickerView.update(settingsPicker);
                        settingsPickerView.box.focus();
                    }
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
                    // The palette closed under the action, and every early
                    // return inside it would otherwise leave nothing focused.
                    // Re-reading the surface here means an action that opened a
                    // pane still lands on the pane.
                    focusActiveSurface();
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

        if (tuiBindingId("composer", key) === "complete_command") {
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

        if (
            tuiBindingId("global", key) === "toggle_thinking"
            && !anyOverlayOpen()
        ) {
            key.preventDefault();
            key.stopPropagation();
            state = toggleTuiThinking(state);
            renderState();
            // Opening every fold grows the transcript above the viewport, which
            // walks the view backwards through the conversation. The reasoning
            // worth reading is the most recent, so the view follows it.
            //
            // Reading the bottom first is what keeps the toggle from costing
            // the follow: setting a scroll position anywhere but the bottom
            // drops sticky scroll for the rest of the session, so a transcript
            // that was keeping up with the stream is put back on the bottom
            // rather than pointed at a row.
            const wasFollowing = transcript.scrollTop
                >= transcript.scrollHeight - transcript.viewport.height;
            const lastThought = state.entries.findLastIndex((entry) =>
                entry.kind === "thought"
            );
            if (wasFollowing) {
                transcript.scrollTo(transcript.scrollHeight);
            } else if (lastThought >= 0) {
                transcript.scrollChildIntoView(`entry-${lastThought}`);
            }
            return;
        }

        const extensionKey = tuiChord(key);
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
    }

    /**
     * Press a key the user did not press. `KeyEvent` carries the whole shape
     * `handleKeypress` reads, so a synthetic press is indistinguishable from a
     * real one once it is in there.
     */
    function pressKey(name: string, sequence = name): void {
        handleKeypress(new KeyEvent({
            name,
            sequence,
            raw: sequence,
            ctrl: false,
            meta: false,
            shift: false,
            option: false,
            number: /^[0-9]$/.test(sequence),
            eventType: "press",
            source: "raw",
        }));
    }

    /**
     * The pointer behaviour every overlay row gets, expressed once.
     *
     * `moveCursor` is the only thing a surface has to supply: how to put its
     * own highlight on row `index`. Hovering is that move; clicking is that
     * move followed by the key the row's highlight responds to, which is ⏎ for
     * a list and the row's own digit for the numbered dialogs.
     */
    function rowPointer(
        moveCursor: (index: number) => void,
        key: "return" | "digit" = "return",
    ): DialogRowPointer {
        if (key === "digit") {
            // No hover: these rows carry their own number and are not reached
            // by a moving highlight, so there is nothing for the pointer to
            // preview.
            return { activate: (index) => pressKey(String(index)) };
        }
        return {
            hover: (index) => {
                moveCursor(index);
                renderState();
            },
            activate: (index) => {
                moveCursor(index);
                pressKey("return", "\r");
            },
        };
    }

    /**
     * Ask the attached session for the state the status line reports.
     *
     * Replayed history carries the transcript and context only, so an
     * attachment that does not ask stays blank about the model and, worse,
     * silent about full access until some later update happens to arrive.
     */
    function requestSessionSettings(): void {
        sendCommand({
            type: "get_model_settings",
            requestId: randomUUID(),
        });
        sendCommand({
            type: "get_permissions",
            requestId: randomUUID(),
        });
    }

    void receiveAgentUpdates();
    void loadExtensionCommands();
    requestSessionSettings();

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
        if (commandAction?.type === "show_diagnostics") {
            composer.rememberSubmittedText(prompt);
            composer.clearComposer();
            renderCommandSuggestions();
            state = appendTuiNotice(state, renderTuiDiagnostics({
                state,
                activity,
                elapsed: elapsedWorkingTime(),
                sessionId: client.agentId,
                workspace: client.workspace ?? process.cwd(),
                runningBackgroundAgents,
                stash: summarizeStash(),
                stashRoot: defaultStashRoot(),
            }));
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
            && commandAction?.type !== "reconnect"
        ) {
            renderStatus();
            return;
        }
        if (commandAction?.type === "update_model") {
            composer.clearComposer();
            requestModelSettingsChange(
                { model: commandAction.model },
                `model → ${commandAction.model}`,
                `the model to ${commandAction.model}`,
            );
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
            requestModelSettingsChange(
                { reasoningEffort: commandAction.reasoningEffort },
                `reasoning → ${commandAction.reasoningEffort}`,
                `reasoning to ${commandAction.reasoningEffort}`,
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
        if (commandAction?.type === "open_subagents_picker") {
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
                const currentId = client.agentId;
                // Children only: the row for the session already on screen
                // would cost a keypress to step past on the way to a child.
                const children = agents.filter(
                    (agent) => agent.parent_id === currentId,
                );
                if (children.length === 0) {
                    settingsPicker = undefined;
                    state = appendTuiNotice(
                        state,
                        "This conversation has no subagents",
                    );
                    focusActiveSurface();
                    renderState();
                    return;
                }
                settingsPicker = startTuiSessionPicker(children, currentId);
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
        if (commandAction?.type === "go_to_parent") {
            composer.clearComposer();
            renderCommandSuggestions();
            if (dependencies.listAgents === undefined) {
                state = appendTuiNotice(state, "Session listing is unavailable");
                renderState();
                return;
            }
            void dependencies.listAgents().then((agents) => {
                if (shuttingDown) {
                    return;
                }
                const current = agents.find(
                    (agent) => agent.id === client.agentId,
                );
                const parent = current?.parent_id === undefined
                    ? undefined
                    : agents.find((agent) => agent.id === current.parent_id);
                if (parent === undefined) {
                    state = appendTuiNotice(
                        state,
                        "This conversation has no parent",
                    );
                    renderState();
                    return;
                }
                beginSessionResume(parent.session_path, parent.id);
            }).catch((error) => {
                if (shuttingDown) return;
                const message = error instanceof Error
                    ? error.message
                    : String(error);
                state = appendTuiNotice(
                    state,
                    `Could not find the parent conversation: ${message}`,
                );
                renderState();
            });
            return;
        }
        if (commandAction?.type === "reconnect") {
            composer.clearComposer();
            const currentAgentId = client.agentId;
            if (
                !connectionFailed
                || dependencies.reconnectSession === undefined
                || currentAgentId === undefined
            ) {
                state = appendTuiNotice(
                    state,
                    connectionFailed
                        ? "Reconnecting this session is unavailable"
                        : "The host connection is already active",
                );
                renderState();
                return;
            }
            sessionSwitchPending = true;
            sessionSwitchActivity = "restarting host…";
            renderState();
            void dependencies.reconnectSession(currentAgentId).then((next) => {
                if (shuttingDown) {
                    void next.detach().catch(() => next.close());
                    return;
                }
                switchToClient(next);
            }).catch((error) => {
                if (shuttingDown) return;
                sessionSwitchPending = false;
                state = appendTuiNotice(
                    state,
                    `Could not reconnect: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
                renderState();
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
            const workspace = client.workspace;
            if (workspace === undefined) {
                state = appendTuiNotice(
                    state,
                    "Current session workspace is unavailable",
                );
                renderState();
                return;
            }
            sessionSwitchPending = true;
            sessionSwitchActivity = "starting new session…";
            renderStatus();
            void dependencies.createSession(workspace).then((next) => {
                if (shuttingDown) {
                    void next.detach().catch(() => next.close());
                    return;
                }
                switchToClient(next);
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
            const sourceAgentId = client.agentId;
            if (sourceAgentId === undefined) {
                state = appendTuiNotice(
                    state,
                    "Current session ID is unavailable",
                );
                renderState();
                return;
            }
            sessionSwitchPending = true;
            sessionSwitchActivity = "cloning session…";
            renderStatus();
            void dependencies.cloneSession(sourceAgentId).then((next) => {
                if (shuttingDown) {
                    void next.detach().catch(() => next.close());
                    return;
                }
                switchToClient(next);
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
        if (commandAction?.type === "compact_session") {
            composer.clearComposer();
            // No reply is awaited: the compaction updates the engine already
            // emits say what happened, and they are the same ones an automatic
            // compaction produces.
            void client.send({ type: "compact", requestId: randomUUID() })
                .catch((error) => {
                    composer.setComposerText(prompt);
                    reportConnectionError(error);
                });
            showStatusNotice("summarizing earlier messages…");
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
        // The chips carry the order the user sees, which reordering the text
        // can change; `pendingImages` only carries the order they arrived in.
        const chipOrder = composer.imageChipRequestIds();
        const attachments = chipOrder
            .flatMap((requestId) => {
                const image = pendingImages.find(
                    (candidate) => candidate.requestId === requestId,
                );
                return image?.id === undefined ? [] : [{
                    id: image.id,
                    ...(image.name === undefined ? {} : { name: image.name }),
                }];
            });
        const attachmentIds = attachments.map((attachment) => attachment.id);
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
                if (!userEntryShows(state.entries.at(-1), prompt, attachments)) {
                    state = beginTuiTurn(state, prompt, attachments);
                } else if (!state.working) {
                    state = { ...state, working: true };
                }
                adoptFallbackSessionTitle(prompt);
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
            : beginTuiTurn(state, prompt, attachments);
        adoptFallbackSessionTitle(prompt);
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
        composer.attachImageChip(requestId);
        sendCommand({ type: "attach_image", requestId, path });
        renderState();
    }

    async function receiveAgentUpdates(): Promise<void> {
        // The session this pump belongs to. A switch bumps the counter, and the
        // await below can still resolve afterwards with an update from the
        // session the user just left.
        const generation = clientGeneration;
        const source = client;
        try {
            while (!shuttingDown && generation === clientGeneration) {
                const update = await source.receive();
                if (shuttingDown || generation !== clientGeneration) {
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
                        const [rejected] = pendingImages.splice(imageIndex, 1);
                        if (rejected !== undefined) {
                            composer.removeImageChip(rejected.requestId);
                        }
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
                        if (update.name === null) {
                            refreshTerminalTitle();
                        } else {
                            sessionTitle = update.name;
                            applyTerminalTitle();
                        }
                    } else {
                        if (
                            pending.commandText !== undefined
                            && composer.expandedText().length === 0
                        ) {
                            composer.setComposerText(pending.commandText);
                        }
                        state = appendTuiNotice(
                            state,
                            update.reason === "invalid"
                                ? "Session name must be 1 to 200 UTF-8 bytes"
                                : "Could not rename this session",
                        );
                    }
                    if (
                        update.type === "session_name"
                        && settingsPicker?.kind === "session"
                    ) {
                        void refreshSessionPicker();
                    }
                    renderState();
                    if (!anyOverlayOpen()) {
                        composer.focus();
                    }
                    focusActiveSurface();
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
                    const subject = requestedModelChanges.get(
                        update.requestId,
                    );
                    requestedModelChanges.delete(update.requestId);
                    if (
                        subject !== undefined
                        && update.type === "model_settings_rejected"
                    ) {
                        state = appendTuiNotice(
                            state,
                            rejectionNotice(subject, update.reason),
                        );
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
                        topPickRows(),
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
                if (update.type === "permissions") {
                    requestedPermissionChanges.delete(update.requestId);
                }
                if (update.type === "permissions_rejected") {
                    // A mode change and a preferences-list removal share this
                    // update, so the request decides which one is being
                    // reported rather than whichever pane happens to be open.
                    const subject = requestedPermissionChanges.get(
                        update.requestId,
                    );
                    requestedPermissionChanges.delete(update.requestId);
                    if (subject !== undefined) {
                        state = appendTuiNotice(
                            state,
                            rejectionNotice(subject, update.reason),
                        );
                    } else if (preferencesList !== undefined) {
                        state = appendTuiNotice(
                            state,
                            update.reason === "unavailable"
                                ? "Removing permissions is unavailable on this host"
                                : "That permission could not be removed",
                        );
                    }
                }
                if (update.type === "history") {
                    const userTexts = update.entries
                        .filter((entry) => entry.kind === "user")
                        .map((entry) => entry.text);
                    composer.loadSubmittedTexts(userTexts);
                    if (userTexts[0] !== undefined) {
                        adoptFallbackSessionTitle(userTexts[0]);
                    }
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
            // A pump left behind by a switch fails on its closed connection.
            // That is the switch working, not the new session losing its host.
            if (generation === clientGeneration) {
                reportConnectionError(error);
            }
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
            request.subtitle,
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

    /**
     * How to focus the overlay in front, or nothing when the composer is it.
     *
     * Held as a lookup rather than folded into `focusActiveSurface` so the same
     * answer serves the question "is the composer the surface this key belongs
     * to", which is what the unfocused-state keys ask.
     */
    function activeOverlayFocus(): (() => void) | undefined {
        if (
            pendingUiRequest !== undefined
            && isToolApprovalUiRequestUpdate(pendingUiRequest)
        ) {
            return () => approvalView.focus();
        }
        if (
            pendingUiRequest !== undefined
            && isUserQuestionUiRequestUpdate(pendingUiRequest)
        ) {
            return () => questionView.focus();
        }
        if (timelinePicker !== undefined) {
            return () => timelinePickerView.box.focus();
        }
        if (commandPalette !== undefined) {
            return () => commandPaletteView.box.focus();
        }
        if (help !== undefined) {
            return () => helpView.box.focus();
        }
        if (confirmingFullAccess) {
            return () => permissionsConfirmView.box.focus();
        }
        if (sessionTrashCandidate !== undefined) {
            return () => sessionTrashConfirmView.box.focus();
        }
        if (sessionRenamePrompt !== undefined) {
            return () => sessionRenamePromptView.box.focus();
        }
        if (secretPrompt !== undefined) {
            return () => secretPromptView.box.focus();
        }
        if (settingsPicker !== undefined) {
            return () => settingsPickerView.box.focus();
        }
        if (preferencesList !== undefined) {
            return () => preferencesListView.box.focus();
        }
        return undefined;
    }

    function focusActiveSurface(): void {
        composer.blur();
        const overlay = activeOverlayFocus();
        if (overlay !== undefined) {
            overlay();
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
        const sourceAgentId = client.agentId;
        if (sourceAgentId === undefined) {
            state = appendTuiNotice(state, "Current session ID is unavailable");
            composer.focus();
            renderState();
            return;
        }
        sessionSwitchPending = true;
        sessionSwitchActivity = "forking session…";
        renderState();
        const fork = dependencies.forkSession(sourceAgentId, boundaryId);
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
        void Promise.race([fork, deadline]).then((result) => {
            clearTimeout(timeout);
            if (shuttingDown) {
                void result.client.detach().catch(() => result.client.close());
                return;
            }
            // The prompt the fork was taken before comes back to the composer,
            // which is the whole point of forking there rather than cloning.
            switchToClient(result.client, {
                text: result.prompt.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join(""),
                attachmentIds: result.prompt.content.flatMap((part) =>
                    part.type === "image_attachment"
                        ? [part.attachmentId]
                        : []
                ),
            });
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
            interruptedRename?.commandText !== undefined
            && composer.expandedText().length === 0
        ) {
            composer.setComposerText(interruptedRename.commandText);
        }
        pendingUiRequest = undefined;
        queuedUiRequests.length = 0;
        timelinePicker = undefined;
        settingsPicker = undefined;
        sessionRenamePrompt = undefined;
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
        const interactiveCardVisible = approvalView.box.visible
            || questionView.box.visible;
        statusText.visible = !interactiveCardVisible;
        backgroundStatusText.visible = !interactiveCardVisible;
        timelinePickerView.box.visible = pendingUiRequest === undefined
            && timelinePicker !== undefined;
        // Over the connect pane it was opened from, so the pane is still there
        // to go back to when the key is saved or the prompt is abandoned.
        sessionRenamePromptView.box.visible = pendingUiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && sessionRenamePrompt !== undefined;
        secretPromptView.box.visible = pendingUiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && sessionRenamePrompt === undefined
            && secretPrompt !== undefined;
        settingsPickerView.box.visible = pendingUiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && secretPrompt === undefined
            && sessionRenamePrompt === undefined
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
            && secretPrompt === undefined
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
                || sessionRenamePromptView.box.visible
                || secretPromptView.box.visible
            ? 0.2
            : 1;
        composerBox.visible = pendingUiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && secretPrompt === undefined
            && sessionRenamePrompt === undefined
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
        if (secretPrompt !== undefined) {
            secretPromptView.update(secretPrompt);
        }
        if (sessionRenamePrompt !== undefined) {
            sessionRenamePromptView.update(sessionRenamePrompt);
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
                if (entry.kind === "tool" && existing instanceof BoxRenderable) {
                    updateTuiToolRow(existing, entry);
                }
                if (
                    (entry.kind === "tool_header"
                        || entry.kind === "thought"
                        || entry.kind === "thinking")
                    && existing instanceof TextRenderable
                ) {
                    // A thought row's height changes when its fold opens and a
                    // thinking row grows with every delta, so both are
                    // re-rendered rather than left as first drawn.
                    existing.content = renderTuiEntry(entry);
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
            const node = entry.kind === "tool"
                ? createTuiToolRow(
                    renderer,
                    `entry-${index}`,
                    entry,
                    marginTop,
                )
                : entry.kind === "user"
                ? createTuiUserEntry(
                    renderer,
                    `entry-${index}`,
                    entry,
                    marginTop,
                )
                : entry.kind === "diff"
                ? createTuiDiff(
                    renderer,
                    `entry-${index}`,
                    tuiDisplayPath(entry.path),
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
            || secretPrompt !== undefined
            || sessionRenamePrompt !== undefined
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

    function openModelPicker(parent?: TuiSettingsPickerState): void {
        settingsPicker = withTuiPickerParent(startTuiSettingsPicker(
            "model",
            state.modelSettings?.model,
            state.modelSettings?.reasoningEffort,
            state.approvalMode,
            state.modelSettings?.availableModels,
            undefined,
            state.modelSettings?.provider,
            undefined,
            state.modelSettings?.pinned,
            topPickRows(),
        ), parent);
        renderState();
        focusActiveSurface();
    }

    /**
     * The shipped suggestions with availability resolved against the runnable
     * list, which is credential-gated at discovery: a pick whose model the
     * host cannot reach right now shows grayed rather than vanishing. Read
     * per open rather than cached, since connecting a provider mid-session
     * changes the answer.
     */
    function topPickRows(): readonly TuiTopPickRow[] {
        let picks: readonly TopPick[];
        try {
            picks = loadTopPicks();
        } catch {
            return [];
        }
        const runnable = state.modelSettings?.availableModels ?? [];
        return picks.map((pick) => ({
            provider: pick.provider,
            model: pick.model,
            label: pick.label,
            description: pick.description,
            ...(pick.reasoning_effort === undefined
                ? {}
                : { reasoningEffort: pick.reasoning_effort }),
            available: runnable.some((candidate) =>
                candidate.provider === pick.provider
                    && candidate.model === pick.model
            ),
        }));
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

    function openReasoningPicker(parent?: TuiSettingsPickerState): void {
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
        settingsPicker = withTuiPickerParent(startTuiReasoningPicker(
            levels,
            current?.defaultLevel,
            state.modelSettings?.reasoningEffort,
        ), parent);
        renderState();
        focusActiveSurface();
    }

    function openPermissionsPicker(parent?: TuiSettingsPickerState): void {
        if (state.permissionInspection !== undefined) {
            state = appendTuiNotice(
                state,
                renderPermissionInspection(state.permissionInspection),
            );
        }
        settingsPicker = withTuiPickerParent(startTuiSettingsPicker(
            "permissions",
            state.modelSettings?.model,
            state.modelSettings?.reasoningEffort,
            state.approvalMode,
            state.modelSettings?.availableModels,
            undefined,
            undefined,
            state.permissionInspection?.availableModes,
        ), parent);
        renderState();
        focusActiveSurface();
    }

    function openThemePicker(parent?: TuiSettingsPickerState): void {
        settingsPicker = withTuiPickerParent(startTuiSettingsPicker(
            "theme",
            state.modelSettings?.model,
            state.modelSettings?.reasoningEffort,
            state.approvalMode,
            state.modelSettings?.availableModels,
            themeName,
        ), parent);
        renderState();
        focusActiveSurface();
    }

    function openPreferencesList(parent?: TuiSettingsPickerState): void {
        // Opened from the cached inspection, then refreshed by the reply to
        // this fetch. Without the fetch the list could be stale, since a
        // client is only sent an inspection at startup and when something
        // changes it.
        preferencesList = startTuiPreferencesList(state.permissionInspection);
        // Its own overlay rather than a picker pane, so the pane it came from
        // is held here instead of on the state, and closing puts it back.
        preferencesListParent = parent;
        sendCommand({ type: "get_permissions", requestId: randomUUID() });
        composer.blur();
        focusActiveSurface();
        renderState();
    }

    /**
     * The store this client reads and writes credentials through, opened once.
     *
     * The TUI touches `~/.vera/auth.json` directly rather than asking the host
     * to write it. The host re-reads the file
     * on every credential check, so a key saved here is in effect on the next
     * turn with nothing to notify.
     */
    const authStorage: AuthStorage = dependencies.authStorage
        ?? createAuthStorage({
            onQuarantine(quarantinePath) {
                state = appendTuiNotice(
                    state,
                    `The old credential file could not be read and was moved to ${quarantinePath}`,
                );
                renderState();
            },
        });
    if (dependencies.authStorage === undefined) {
        // Said once, at the point where the pane would otherwise just look
        // empty for no stated reason. The store is left alone until something
        // is actually written to it.
        const unreadable = unreadableAuthStoragePath();
        if (unreadable !== undefined) {
            state = appendTuiNotice(
                state,
                `${unreadable} could not be read, so no provider shows as connected. Connecting one rewrites it.`,
            );
        }
    }
    /** Providers with a browser sign-in already running, so Enter cannot start a second. */
    const connectingProviders = new Set<string>();

    /**
     * Whether Vera already holds a credential, with an unreadable store read as
     * "no". The pane is a list of what to connect, so a broken `auth.json`
     * should show everything as unconnected rather than throw inside a keypress.
     */
    function providerConnected(provider: Parameters<typeof isProviderConnected>[0]): boolean {
        try {
            return isProviderConnected(provider, { authStorage });
        } catch {
            return false;
        }
    }

    function openProviderPicker(parent?: TuiSettingsPickerState): void {
        settingsPicker = withTuiPickerParent(
            startTuiProviderPicker(PROVIDERS.map((provider) => ({
                id: provider.id,
                label: provider.label,
                group: provider.group === "popular" ? "Popular" : "Providers",
                ...(provider.hint === undefined ? {} : { hint: provider.hint }),
                connected: providerConnected(provider),
            }))),
            parent,
        );
        composer.blur();
        renderState();
        focusActiveSurface();
    }

    /**
     * Connect one provider, by whatever it is that provider wants.
     *
     * A row that needs no credential says so rather than pretending to connect,
     * since a check mark appearing for a step that never happened is the one
     * thing this pane cannot afford to get wrong.
     */
    function connectProvider(
        providerId: string,
        pane: TuiSettingsPickerState | undefined,
    ): void {
        const provider = findProvider(providerId);
        if (provider === undefined) {
            return;
        }
        if (provider.credential === "api_key") {
            secretPrompt = startTuiSecretPrompt(provider, pane);
            settingsPicker = undefined;
            composer.blur();
            renderState();
            focusActiveSurface();
            return;
        }
        settingsPicker = pane;
        if (provider.credential === "none") {
            state = appendTuiNotice(
                state,
                `${provider.label} needs no credentials${
                    provider.envVar === undefined
                        ? ""
                        : `, point it elsewhere with ${provider.envVar}`
                }`,
            );
            renderState();
            return;
        }
        // The browser hand-off runs while the pane stays open, so the URL and
        // the outcome both arrive as notices behind it rather than as a modal
        // that has nothing to offer but waiting. The pane staying open also
        // means Enter can land twice, and the callback listener binds a fixed
        // port, so a second run would fail on the first one's own server.
        if (connectingProviders.has(provider.id)) {
            return;
        }
        connectingProviders.add(provider.id);
        state = appendTuiNotice(state, `opening a browser to sign in to ${provider.label}…`);
        renderState();
        void (dependencies.loginProvider ?? defaultLoginProvider)(
            provider.id,
            (url) => {
                state = appendTuiNotice(state, `sign in at ${url}`);
                renderState();
            },
        ).then(() => {
            connectingProviders.delete(provider.id);
            state = appendTuiNotice(state, `connected to ${provider.label}`);
            if (settingsPicker?.kind === "provider") {
                openProviderPicker(settingsPicker.parent);
                return;
            }
            renderState();
        }, (error: unknown) => {
            connectingProviders.delete(provider.id);
            state = appendTuiNotice(
                state,
                `could not connect to ${provider.label}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            renderState();
        });
    }

    async function defaultLoginProvider(
        providerId: string,
        onAuthorizationUrl: (url: string) => void,
    ): Promise<void> {
        if (providerId !== "openai-codex") {
            throw new Error(`No sign-in flow for provider ${providerId}`);
        }
        await loginOpenAICodex({ authStorage, onAuthorizationUrl });
    }

    function applySecretPromptTransition(
        prompt: TuiSecretPromptState,
        transition: { readonly state?: TuiSecretPromptState; readonly submitted?: string },
    ): void {
        secretPrompt = transition.state;
        if (secretPrompt !== undefined) {
            renderState();
            return;
        }
        if (transition.submitted !== undefined) {
            try {
                authStorage.setCredential(prompt.providerId, {
                    type: "api_key",
                    key: transition.submitted,
                });
                state = appendTuiNotice(state, `stored ${prompt.label} API key`);
            } catch (error) {
                state = appendTuiNotice(
                    state,
                    `could not store the ${prompt.label} API key: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }
        // Back to the pane the prompt was opened over, rebuilt so the row it
        // came from carries its new mark.
        if (prompt.parent?.kind === "provider") {
            openProviderPicker(prompt.parent.parent);
            return;
        }
        settingsPicker = prompt.parent;
        renderState();
        focusActiveSurface();
    }

    /**
     * The name a picker row was given.
     *
     * The current session is renamed through its own attachment, because that
     * is the client holding the name on screen and the host refuses to write
     * behind an attached client's back. Every other row goes over the host.
     */
    function applySessionRenamePromptTransition(
        prompt: TuiSessionRenamePromptState,
        transition: TuiSessionRenamePromptTransition,
    ): void {
        sessionRenamePrompt = transition.state;
        if (sessionRenamePrompt !== undefined) {
            renderState();
            return;
        }
        const parent = prompt.parent;
        settingsPicker = parent;
        if (transition.submitted !== undefined) {
            if (prompt.sessionId === client.agentId) {
                const requestId = randomUUID();
                pendingSessionRename = { requestId };
                sendCommand({
                    type: "update_session_name",
                    requestId,
                    name: transition.submitted,
                });
            } else {
                void performSessionRename(
                    prompt.sessionId,
                    transition.submitted,
                );
            }
        }
        renderState();
        focusActiveSurface();
    }

    async function performSessionRename(
        sessionId: string,
        name: string | null,
    ): Promise<void> {
        if (dependencies.renameSession === undefined) {
            state = appendTuiNotice(
                state,
                "Renaming another conversation is unavailable",
            );
            renderState();
            return;
        }
        const generation = clientGeneration;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
            dependencies.renameSession(sessionId, name)
                .catch((): RenameSessionResult => ({
                    status: "rejected",
                    reason: "failed",
                })),
            new Promise<RenameSessionResult>((resolve) => {
                timeout = setTimeout(() => {
                    resolve({ status: "rejected", reason: "failed" });
                }, dependencies.sessionSwitchTimeoutMs
                    ?? SESSION_SWITCH_TIMEOUT_MS);
            }),
        ]);
        clearTimeout(timeout);
        // The session on screen may have been swapped underneath while the
        // host was answering, and this result belongs to the one that left.
        if (shuttingDown || generation !== clientGeneration) return;
        state = appendTuiNotice(
            state,
            result.status === "renamed"
                ? result.name === null
                    ? "session name cleared"
                    : `session renamed: ${result.name}`
                : result.reason === "busy"
                ? "That conversation is open in another client"
                : result.reason === "not_found"
                ? "That conversation is no longer available"
                : result.reason === "invalid"
                ? "Session name must be 1 to 200 UTF-8 bytes"
                : "Could not rename that conversation",
        );
        if (result.status === "renamed" && settingsPicker?.kind === "session") {
            await refreshSessionPicker();
        }
        renderState();
    }

    /**
     * The session pane, rebuilt from the host.
     *
     * A rename changes what a row says, and the row text comes from the host
     * listing, so the pane is re-read rather than patched with what was asked
     * for.
     */
    async function refreshSessionPicker(): Promise<void> {
        if (dependencies.listAgents === undefined) return;
        const generation = clientGeneration;
        try {
            const agents = await dependencies.listAgents();
            if (
                shuttingDown || generation !== clientGeneration
                || settingsPicker?.kind !== "session"
            ) {
                return;
            }
            settingsPicker = startTuiSessionPicker(agents, client.agentId);
            renderState();
        } catch {
            // The pane keeps the rows it has: a failed refresh is not a
            // reason to close what the user is working in.
        }
    }

    function openSettingsMenu(): void {
        settingsPicker = startTuiSettingsMenu("settings");
        composer.blur();
        renderState();
        focusActiveSurface();
    }

    function openSettingsMenuTarget(
        target: TuiSettingsMenuTarget,
        parent?: TuiSettingsPickerState,
    ): void {
        if (target === "model") return openModelPicker(parent);
        if (target === "reasoning") return openReasoningPicker(parent);
        if (target === "theme") return openThemePicker(parent);
        if (target === "permission_mode") return openPermissionsPicker(parent);
        if (target === "granted_permissions") return openPreferencesList(parent);
        settingsPicker = withTuiPickerParent(
            startTuiSettingsMenu("permission_settings"),
            parent,
        );
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
        if (
            "renameCandidate" in transition
            && transition.renameCandidate !== undefined
        ) {
            sessionRenamePrompt = startTuiSessionRenamePrompt(
                transition.renameCandidate,
                previousPicker?.kind === "extension"
                    ? undefined
                    : previousPicker,
            );
            renderState();
            focusActiveSurface();
            return;
        }
        if ("openProviders" in transition && transition.openProviders === true) {
            // The model pane stays underneath: connecting a provider is a
            // detour on the way to picking a model, not a change of subject.
            openProviderPicker(
                previousPicker?.kind === "extension" ? undefined : previousPicker,
            );
            return;
        }
        if ("pinToggle" in transition && transition.pinToggle !== undefined) {
            // The pane stays open and stays on the same row. It is not updated
            // here: the settings snapshot that comes back rebuilds it, so what
            // the user sees is what the host stored rather than a guess.
            sendCommand({
                type: "update_pin",
                requestId: randomUUID(),
                action: transition.pinToggle.action,
                provider: transition.pinToggle.provider,
                model: transition.pinToggle.model,
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
                const chosen = selection.reasoningEffort === undefined
                    ? `${selection.provider}/${selection.model}`
                    : `${selection.provider}/${selection.model} (${selection.reasoningEffort})`;
                requestModelSettingsChange(
                    {
                        provider: selection.provider,
                        model: selection.model,
                        ...(selection.reasoningEffort === undefined
                            ? {}
                            : { reasoningEffort: selection.reasoningEffort }),
                    },
                    `model → ${chosen}`,
                    `the model to ${chosen}`,
                );
            } else if (selection.kind === "provider") {
                connectProvider(
                    selection.providerId,
                    previousPicker?.kind === "extension"
                        ? undefined
                        : previousPicker,
                );
                return;
            } else if (selection.kind === "reasoning") {
                requestModelSettingsChange(
                    { reasoningEffort: selection.reasoningEffort },
                    `reasoning → ${selection.reasoningEffort}`,
                    `reasoning to ${selection.reasoningEffort}`,
                );
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
                // A menu row opens the next surface over this one, which stays
                // remembered as its parent so leaving comes back here.
                settingsPicker = undefined;
                openSettingsMenuTarget(
                    selection.target,
                    previousPicker?.kind === "extension"
                        ? undefined
                        : previousPicker,
                );
                return;
            } else {
                beginSessionResume(selection.sessionPath, selection.sessionId);
                return;
            }
            // An answered pane returns to the menu it was opened from, so
            // changing the model and then the theme is one trip through
            // /settings rather than two. A confirmation is the exception: it
            // is its own modal level, and the menu would sit open behind it.
            settingsPicker = confirmingFullAccess
                || previousPicker === undefined
                || previousPicker.kind === "extension"
                ? undefined
                : tuiPickerMenuAncestor(previousPicker);
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

    /**
     * Put another session on screen without taking the screen away.
     *
     * The renderer, the extension registry, the theme, and the composer's own
     * widgets all outlive the switch: nothing about them belongs to a session.
     * What is reset is everything the old session put on screen or was waiting
     * on, and the host refills the transcript by replaying history to the new
     * attachment, which is the same path a fresh attach already takes.
     *
     * The draft carries over on purpose. A half-written prompt is the user's,
     * not the session's, and losing it to a keystroke that was meant to change
     * which conversation it lands in is the worst possible time to lose it.
     */
    function switchToClient(next: TuiAgentClient, draft?: TuiDraft): void {
        const previous = client;
        clientGeneration += 1;
        client = next;
        setTuiWorkspaceRoot(next.workspace ?? process.cwd());
        void previous.detach().catch(() => previous.close());

        state = createTuiState();
        if (next.agentId !== undefined) {
            try {
                dependencies.onSessionEntered?.(next.agentId);
            } catch (error) {
                state = appendTuiNotice(state, recentSessionSaveFailure(error));
            }
        }
        connectionFailed = false;
        abortRequested = false;
        workingSince = undefined;
        phaseSince = undefined;
        pendingUiRequest = undefined;
        queuedUiRequests.length = 0;
        pendingImages = [];
        submitAfterImageAttachment = false;
        promptSubmitting = false;
        pendingSessionRename = undefined;
        sessionSwitchPending = false;
        sessionTrashCandidate = undefined;
        sessionTrashPending = false;
        timelinePicker = undefined;
        settingsPicker = undefined;
        secretPrompt = undefined;
        sessionRenamePrompt = undefined;
        preferencesList = undefined;
        preferencesListParent = undefined;
        confirmingFullAccess = false;
        hostExtensionCommands = [];
        extensionCommandsLoading = next.listExtensionCommands !== undefined;
        sessionTitle = undefined;
        applyTerminalTitle();
        refreshTerminalTitle();
        clearTranscriptNodes();

        composer.clearComposer();
        if (draft !== undefined) {
            composer.setComposerText(draft.text);
            pendingImages = draft.attachmentIds.map((id) => ({
                requestId: randomUUID(),
                id,
            }));
        }
        settingsPickerView.box.visible = false;
        focusActiveSurface();
        renderCommandSuggestions();
        renderState();
        void loadExtensionCommands();
        void receiveAgentUpdates();
        requestSessionSettings();
    }

    /**
     * Move to the session a picker row named.
     *
     * The draft is read before the switch and handed back to it, so a prompt
     * typed against the wrong conversation can be sent to the right one.
     */
    function beginSessionResume(
        sessionPath: string,
        sessionId?: string,
    ): void {
        settingsPicker = undefined;
        if (sessionId !== undefined && sessionId === client.agentId) {
            // The row for the session already on screen. Tearing down that
            // session's own transcript to put it back is a worse answer to
            // "this one" than simply leaving.
            settingsPickerView.box.visible = false;
            focusActiveSurface();
            renderState();
            return;
        }
        if (dependencies.resumeSession === undefined) {
            state = appendTuiNotice(state, "Switching sessions is unavailable");
            settingsPickerView.box.visible = false;
            focusActiveSurface();
            renderState();
            return;
        }
        if (sessionSwitchPending) {
            return;
        }
        const draft = currentDraft();
        sessionSwitchPending = true;
        sessionSwitchActivity = "switching conversation…";
        settingsPickerView.box.visible = false;
        renderState();
        void dependencies.resumeSession(sessionPath).then((next) => {
            if (shuttingDown) {
                void next.detach().catch(() => next.close());
                return;
            }
            switchToClient(next, draft);
        }).catch((error) => {
            if (shuttingDown) return;
            sessionSwitchPending = false;
            state = appendTuiNotice(
                state,
                `Could not switch conversation: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            focusActiveSurface();
            renderState();
        });
    }

    /** What is in the composer right now, absent when it is empty. */
    function currentDraft(): TuiDraft | undefined {
        const text = composer.plainText;
        const attachmentIds = pendingImages
            .map((image) => image.id)
            .filter((id): id is string => id !== undefined);
        return text.length === 0 && attachmentIds.length === 0
            ? undefined
            : { text, attachmentIds };
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

    /**
     * Send a model settings edit and toast what was asked for.
     *
     * `toast` is what the status line shows while the change is in flight;
     * `subject` completes "Could not change …" if the engine rejects it.
     */
    function requestModelSettingsChange(
        patch: ModelSettingsPatch,
        toast: string,
        subject: string,
    ): void {
        const requestId = randomUUID();
        requestedModelChanges.set(requestId, subject);
        sendCommand({ type: "update_model_settings", requestId, patch });
        showStatusNotice(toast);
    }

    function requestPermissionsChange(mode: string): void {
        const requestId = randomUUID();
        requestedPermissionChanges.set(requestId, `permissions to ${mode}`);
        sendCommand({ type: "update_permissions", requestId, mode });
        showStatusNotice(`permissions → ${mode}`);
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
        clearTranscriptNodes();
        markdownStyle.destroy();
        markdownStyle = createMarkdownStyle(theme);

        placeholder.fg = theme.muted;
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
        approvalView.repaint();
        questionView.box.backgroundColor = theme.panel;
        questionView.bar.backgroundColor = theme.accent;
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
            lifecycleHint = "disconnected · /reconnect host · ctrl+c quit";
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
            const modelActivity = state.modelActivity;
            const waitingToRetry = modelActivity !== undefined
                && Date.parse(modelActivity.retryAt) > Date.now();
            lifecycleHint = waitingToRetry
                ? `retrying · attempt ${modelActivity.nextAttempt}/${modelActivity.maxAttempts}`
                    + ` · ${elapsedWorkingTime()} · ${WORKING_HINT}`
                : `${modelActivity === undefined ? activity : "thinking"}`
                    + ` · ${elapsedWorkingTime()} · ${WORKING_HINT}`;
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
        const statusDetailsLine = renderTuiStatusDetailsLine(
            state.modelSettings,
            state.approvalMode,
            state.context,
            process.cwd(),
            0,
        );
        const runningNames = runningBackgroundAgentNames === ""
            ? []
            : runningBackgroundAgentNames
                .split("\n")
                .map((name) =>
                    truncateFooterLine(
                        name,
                        Math.min(72, renderer.width - 8),
                    )
                );
        const agentSection = currentAgentHasParent
            ? ["/parent to return"]
            : runningNames.length === 0
                ? []
                : [
                    `${runningNames.length} subagent${
                        runningNames.length === 1 ? "" : "s"
                    } running · /subagents to attach`,
                    ...runningNames,
                ];
        const agentHeader = agentSection[0] ?? "";
        const animatedAgentHeader = runningNames.length === 0
            ? new StyledText([fg(TUI_MUTED)(agentHeader)])
            : renderTuiActivityAnimation(
                activityAnimation,
                activityFrame(),
                agentHeader,
                {
                    active: TUI_ACCENT,
                    trail: VERA_TUI_THEME.success,
                    inactive: TUI_ELEMENT,
                    text: TUI_MUTED,
                },
                activityAnimationWidth,
            );
        backgroundStatusText.content = agentSection.length === 0
            ? statusDetailsLine
            : new StyledText([
                fg(TUI_MUTED)(`${statusDetailsLine}\n`),
                fg(TUI_ELEMENT)(
                    `${"·".repeat(Math.max(1, renderer.width - 4))}\n`,
                ),
                ...animatedAgentHeader.chunks,
                fg(TUI_MUTED)(
                    agentSection.length === 1
                        ? ""
                        : `\n${agentSection.slice(1).join("\n")}`,
                ),
            ]);
        backgroundStatusText.height = agentSection.length === 0
            ? 1
            : 2 + agentSection.length;
        statusText.bottom = backgroundStatusText.height;
        composerBox.marginBottom = 1 + backgroundStatusText.height;
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
            dependencies.listAgents === undefined
            || backgroundAgentRefreshPending
            || shuttingDown
        ) {
            return;
        }
        backgroundAgentRefreshPending = true;
        try {
            const agents = await dependencies.listAgents();
            const nextCount = countRunningBackgroundAgents(agents);
            const nextNames = renderBackgroundAgentNames(
                agents,
                client.agentId,
            );
            const nextHasParent = agents.some((agent) =>
                agent.id === client.agentId && agent.parent_id !== undefined,
            );
            if (!shuttingDown && (nextCount !== runningBackgroundAgents
                || nextNames !== runningBackgroundAgentNames
                || nextHasParent !== currentAgentHasParent)) {
                runningBackgroundAgents = nextCount;
                runningBackgroundAgentNames = nextNames;
                currentAgentHasParent = nextHasParent;
                renderStatus();
            }
        } catch {
            if (!shuttingDown && (runningBackgroundAgents !== 0
                || runningBackgroundAgentNames !== ""
                || currentAgentHasParent)) {
                runningBackgroundAgents = 0;
                runningBackgroundAgentNames = "";
                currentAgentHasParent = false;
                renderStatus();
            }
        } finally {
            backgroundAgentRefreshPending = false;
        }
    }

    function observeActivity(update: AgentUpdate): void {
        if (update.type === "status" && update.state === "working") {
            workingSince ??= Date.now();
            phaseSince ??= workingSince;
            activity = "thinking";
        } else if (update.type === "status" && update.state === "waiting") {
            workingSince ??= Date.now();
            phaseSince = undefined;
            activity = "waiting";
        } else if (update.type === "model_activity") {
            workingSince ??= Date.now();
            activity = `retrying ${update.model}`;
        } else if (update.type === "user_prompt") {
            workingSince ??= Date.now();
            phaseSince = Date.now();
            activity = "thinking";
        } else if (update.type === "assistant_thinking") {
            // Reasoning can resume after visible text, so each burst re-arms the
            // phase and earns its own summary line.
            workingSince ??= Date.now();
            phaseSince ??= Date.now();
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
            state = dropTuiThinking(state);
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

function recentSessionSaveFailure(error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    return `Could not remember this session for vera -c: ${detail}`;
}

function rejectionNotice(
    subject: string,
    reason: "invalid" | "unavailable",
): string {
    return reason === "unavailable"
        ? `Changing ${subject} is unavailable on this host`
        : `Could not change ${subject}`;
}
