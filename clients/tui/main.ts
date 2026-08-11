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
    RGBA,
    type Selection,
} from "@opentui/core";
import { randomUUID } from "node:crypto";
import { sourceVersion } from "../../src/build-info.ts";
import { openFileInEditor, veraConfigPath } from "../editor.ts";

import {
    DIALOG_BACKGROUND_OPACITY,
    DIALOG_BACKGROUND_Z_INDEX,
    DIALOG_SCRIM_Z_INDEX,
    type DialogRowPointer,
} from "./dialog-chrome.ts";

import {
    isToolApprovalUiRequestUpdate,
    isTimelineReplyUpdate,
    isUserQuestionUiRequestUpdate,
    type AgentUpdate,
    type AttachmentRef,
    type ClientCommand,
    type UiRequestUpdate,
} from "../../src/engine/protocol.ts";
import type { ModelSettingsPatch } from "../../src/engine/model-settings.ts";
import type { UserMessage } from "../../src/model/types.ts";
import type {
    ReasoningLevel,
    ReasoningLevelId,
} from "../../src/model/catalog-shape.ts";
import {
    loadOptionalVeraConfig,
    tipsEnabled as configuredTipsEnabled,
    type VeraExtensionConfig,
} from "../../src/config.ts";
import {
    loadPoolFile,
    poolFileIssueNotices,
} from "../../src/model/pool-file-loader.ts";
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
    VeraClientConsultRequest,
    VeraClientConsultResult,
    VeraClientModelSettingsPatch,
    VeraClientModelSettingsUpdateResult,
    VeraClientPickerRequest,
    VeraClientPickerResult,
    VeraClientAgentCreateRequest,
    VeraClientAgentOpenRequest,
    VeraClientAgentMessageRequest,
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
import type { BackgroundAgentsSnapshot } from "../../src/host/background-agents.ts";
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
import { createTuiSidebar } from "./sidebar.ts";
import { TuiAgentPane } from "./agent-pane.ts";
import { routeTuiAgentMessage } from "./agent-message-routing.ts";
import { renderTuiDiagnostics } from "./diagnostics.ts";
import {
    createTuiDiagnosticsDialogView,
    handleTuiDiagnosticsDialogKey,
    type TuiDiagnosticsDialogState,
} from "./diagnostics-dialog.ts";
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
    renderTuiArgumentSuggestions,
    renderTuiCommandSuggestions,
    tuiSuggestionWindow,
    tuiArgumentCompletion,
    tuiArgumentSuggestions,
    tuiCommandScope,
    tuiWithArgument,
    type TuiCommandAction,
    type TuiCommandCatalogEntry,
    type TuiPaletteEntry,
} from "./commands.ts";
import {
    COMPOSER_PLACEHOLDER,
    createTuiComposer,
    createTuiComposerPanel,
    TUI_COMPOSER_PANEL_ROWS,
} from "./composer.ts";
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
import {
    createTuiAdmissionDialogView,
    handleTuiAdmissionDialogKey,
    startTuiAdmissionDialog,
    type TuiAdmissionDialogState,
} from "./admission-dialog.ts";
import { renderTuiHeldAddress } from "./addressing.ts";
import { parseRawInputEvent, tuiInterruptAction } from "./interrupt.ts";
import { isTranscriptSelection, selectionSpeaker } from "./selection.ts";
import {
    renderTuiQuote,
    tuiQuoteMarker,
    withQuote,
    type TuiQuote,
} from "./quote.ts";
import {
    renderTuiIdleHint,
    renderTuiStatusDetailsRows,
    renderTuiStatusSegments,
    tuiStatusSnapshot,
    statusToneColor,
    type TuiStatusChunk,
} from "./status.ts";
import { watchWorkspaceBranch } from "./workspace-branch.ts";
import {
    createTuiSettingsPickerView,
    handleTuiSettingsPickerScroll,
    handleTuiSettingsPickerKey,
    tuiPickerViewportRows,
    startTuiReviewerMenu,
    startTuiReviewerPicker,
    startTuiSettingsMenu,
    startTuiSettingsPicker,
    switchedModelTab,
    syncTuiModelPicker,
    startTuiReasoningPicker,
    startTuiSessionPicker,
    startTuiExtensionPicker,
    startTuiProviderPicker,
    tuiPickerAfterSelection,
    withTuiPickerParent,
    type TuiSettingsMenuTarget,
    type TuiAnySettingsPickerState,
    type TuiReviewerSlot,
    type TuiSettingsPickerState,
    type TuiSettingsPickerTransition,
    type TuiExtensionPickerAction,
    type TuiExtensionPickerTransition,
} from "./settings-picker.ts";
import {
    createTuiSecretPromptView,
    handleTuiSecretPromptKey,
    handleTuiSecretPromptPaste,
    startTuiSecretPrompt,
    type TuiSecretPromptState,
} from "./secret-prompt.ts";
import {
    createTuiNamePromptView,
    handleTuiNamePromptKey,
    handleTuiNamePromptPaste,
    startTuiNamePrompt,
    type TuiNamePromptState,
    type TuiNamePromptTransition,
} from "./name-prompt.ts";
import {
    tuiBindingId,
    tuiChord,
    tuiChordOwner,
    tuiKeyHint,
} from "./keymap.ts";
import {
    recordTuiTipShown,
    selectTuiTip,
    TUI_TIPS,
    type TuiTip,
    type TuiTipContext,
} from "./tips.ts";
import {
    beginTuiTipLaunch,
    saveTuiTipState,
    type TuiTipState,
} from "./tips-store.ts";
import { createRenderCoalescer } from "./render-coalescer.ts";
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
    appendTuiExtensionBlock,
    appendTuiError,
    appendTuiNotice,
    appendTuiThought,
    dropTuiThinking,
    toggleTuiThinking,
    toggleTuiToolDetails,
    applyAgentUpdate,
    userEntryShows,
    beginNextQueuedTuiTurn,
    beginTuiAdmission,
    dropTuiAdmission,
    beginTuiTurn,
    createTuiState,
    failTuiConnection,
    queueTuiPrompt,
    renderTuiEntry,
    renderTuiQueuedPrompt,
    tuiPoolListing,
    setTuiWorkspaceRoot,
    tuiDisplayPath,
    tuiEntryMarginTop,
    type TuiState,
    type TuiTranscriptEntry,
} from "./state.ts";
import {
    resolveTuiTheme,
    tuiHandleActiveColor,
    tuiHandleColor,
    VERA_TUI_THEME,
} from "./theme.ts";
import {
    loadTuiActivityAnimationPreference,
    loadTuiActivityAnimationIntervalPreference,
    loadTuiActivityAnimationWidthPreference,
    loadTuiSidebarWidth,
    loadTuiSharedSessionGroups,
    loadTuiPersistedAgentPane,
    saveTuiSidebarWidth,
    saveTuiSharedSessionGroups,
    saveTuiPersistedAgentPane,
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
import {
    createTuiToolHeader,
    createTuiToolRow,
    updateTuiToolHeader,
    updateTuiToolRow,
} from "./tool-row.ts";
import {
    createTuiMarkdownEntry,
    tuiMarkdownEntryContent,
} from "./markdown-entry.ts";

// The palette has no other advertisement: it is a chord, not a slash command in
// the composer's list, so the idle status line is where you find out it exists.
const READY_HINT = `ready · ${tuiKeyHint("open_palette")}`;
const WORKING_HINT = `enter queue · esc stop · ${tuiKeyHint("interrupt")}`;
const STOPPING_HINT = "stopping…";
// The question overlay owns the choose/cancel hint now, so the status line only
// carries the waiting phase and the global interrupt.
const QUESTION_HINT = `question waiting · ${tuiKeyHint("interrupt")}`;
const COPY_NOTICE_DURATION_MS = 1_500;
const MODE_TOAST_DURATION_MS = 2_500;
const STATUS_REFRESH_INTERVAL_MS = 100;
const DIRECT_EXTENSION_COMMAND_TIMEOUT_MS = 2_000;
const SYMMETRIC_WAVE_FRAME_INTERVAL_MS = 360;
const SHIMMER_FRAME_INTERVAL_MS = 40;
const DEFAULT_ACTIVITY_FRAME_INTERVAL_MS = 160;
const SESSION_SWITCH_TIMEOUT_MS = 15_000;
const POINTER_HOVER_DELAY_MS = 25;
/** Rows the composer, the status band and a little transcript need. */
const SUGGESTIONS_RESERVED_ROWS = 12;

function assistantFollowsWork(
    entries: readonly TuiTranscriptEntry[],
    index: number,
): boolean {
    if (entries[index]?.kind !== "assistant") return false;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const kind = entries[cursor]?.kind;
        if (kind === "user" || kind === "assistant") return false;
        if (
            kind === "tool"
            || kind === "tool_header"
            || kind === "thinking"
            || kind === "thought"
            || kind === "review"
            || kind === "notice"
            || kind === "extension_label"
            || kind === "substitution"
            || kind === "diff"
        ) return true;
    }
    return false;
}

function truncateFooterLine(text: string, width: number): string {
    const characters = Array.from(text);
    const limit = Math.max(1, width);
    return characters.length <= limit
        ? text
        : `${characters.slice(0, limit - 1).join("").trimEnd()}…`;
}

function displayModeLabel(label: string): string {
    return `${label.slice(0, 1).toUpperCase()}${label.slice(1)}`;
}

export interface TuiDependencies {
    readonly client: TuiAgentClient;
    readonly copyText?: (text: string) => Promise<void>;
    readonly openConfigure?: () => Promise<void>;
    readonly listAgents?: () => Promise<readonly RegisteredAgentSummary[]>;
    /**
     * The four ways to reach another session, each handed the identity of the
     * one being left rather than closing over it.
     *
     * They used to read the current client from the scope that started the TUI,
     * which was true exactly once: after the first switch that binding pointed
     * at a session the user had already left, and cloning would have cloned it.
     */
    readonly createSession?: (workspace: string) => Promise<TuiAgentClient>;
    readonly createAgent?: (
        workspace: string,
        approvalMode?: string,
        lifetime?: "ephemeral" | "durable",
    ) => Promise<TuiAgentClient>;
    readonly attachAgent?: (agentId: string) => Promise<TuiAgentClient>;
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
    readonly build?: {
        readonly clientVersion: string;
        readonly clientEntrypoint: string;
        readonly hostEntrypoint?: string;
        readonly hostPid?: number;
        readonly hostStartedAt?: string;
    };
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
    /** Background work as of the attach, before anything has changed. */
    readonly backgroundAgents?: AttachedAgentClient["backgroundAgents"];
    onBackgroundAgents?: AttachedAgentClient["onBackgroundAgents"];
    send(command: ClientCommand): Promise<void>;
    receive(signal?: AbortSignal): Promise<AgentUpdate>;
    listExtensionCommands?: AttachedAgentClient["listExtensionCommands"];
    runExtensionCommand?: AttachedAgentClient["runExtensionCommand"];
    detach(): Promise<void>;
    close(): void;
}

type IdentifiedTuiAgentClient = TuiAgentClient & { readonly agentId: string };

function requireIdentifiedClient(
    client: TuiAgentClient,
): IdentifiedTuiAgentClient {
    if (client.agentId === undefined || client.agentId.length === 0) {
        client.close();
        throw new Error("Attached agent has no identity");
    }
    return client as IdentifiedTuiAgentClient;
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
            undefined,
            undefined,
            resolvedTarget.startupProfile,
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
        // A pool file the parser had to reduce still produced a pool, so this
        // says so instead of failing: the entries that were dropped are the
        // ones the user thinks are in force.
        const startupNotices = [
            ...(mismatchNotice === undefined ? [] : [mismatchNotice]),
            ...poolFileIssueNotices(
                loadPoolFile({ projectRoot: process.cwd() }).issues,
            ),
        ];
        const exit = await startTui({
            client,
            ...(startupNotices.length === 0 ? {} : { startupNotices }),
            listAgents,
            createSession: async (workspace) =>
                attach((await createAgentThroughHost(
                    host.socket_path,
                    workspace,
                )).id),
            createAgent: async (workspace, approvalMode, lifetime = "durable") =>
                attach((await createAgentThroughHost(
                    host.socket_path,
                    workspace,
                    approvalMode,
                    lifetime,
                )).id),
            attachAgent: attach,
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
            build: {
                clientVersion: sourceVersion(import.meta.dir),
                clientEntrypoint: import.meta.path,
                ...(host.entrypoint === undefined
                    ? {}
                    : { hostEntrypoint: host.entrypoint }),
                hostPid: host.pid,
                hostStartedAt: host.started_at,
            },
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
    const sidebarWidth = loadTuiSidebarWidth();
    let sharedSessionGroups = loadTuiSharedSessionGroups();
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
    let followTranscriptAfterUiRequest = false;
    let timelinePicker: TuiTimelinePickerState | undefined;
    let settingsPicker: TuiAnySettingsPickerState | undefined;
    let settingsPickerAgent: TuiAgentClient | undefined;
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
    let messageInterceptPending = false;
    let secretPrompt: TuiSecretPromptState | undefined;
    let namePrompt: TuiNamePromptState | undefined;
    let preferencesList: TuiPreferencesListState | undefined;
    /** The picker pane the preferences list was opened over, restored on close. */
    let preferencesListParent: TuiSettingsPickerState | undefined;
    let commandPalette: TuiCommandPaletteState | undefined;
    let help: TuiHelpState | undefined;
    let diagnosticsDialog: TuiDiagnosticsDialogState | undefined;
    let hostExtensionCommands: readonly ExtensionCommandDescriptor[] = [];
    let confirmingFullAccess = false;
    let confirmingFullAccessAgent: TuiAgentClient | undefined;
    /**
     * The pool add whose name prompt is still owed, if any. Naming is offered
     * once, at the moment the entry appears, and skipping it is a plain escape.
     */
    let pendingPoolName: {
        readonly requestId: string;
        readonly provider: string;
        readonly model: string;
        readonly label: string;
    } | undefined;
    interface PoolChangeUndo {
        readonly action: "add" | "remove";
        readonly provider: string;
        readonly model: string;
        readonly poolName?: string;
    }
    const pendingPoolChanges = new Map<string, PoolChangeUndo>();
    const pendingPoolUndos = new Map<string, {
        readonly undo: PoolChangeUndo;
        readonly completesOnSettings: boolean;
    }>();
    let poolChangeUndo: PoolChangeUndo | undefined;
    let admissionDialog: TuiAdmissionDialogState | undefined;
    /** The model pane the dialog covered, put back when the dialog leaves. */
    let admissionReturnPicker: TuiSettingsPickerState | undefined;
    /**
     * The settings change each in-flight admission was meant to end in,
     * applied when its "added" verdict lands. Keyed by requestId rather than
     * held on the dialog: hiding the dialog must not lose the switch.
     */
    let sessionTrashCandidate: {
        readonly sessionId: string;
        readonly label: string;
    } | undefined;
    let sessionTrashPending = false;
    let commandSuggestionIndex = 0;
    /** Whether the highlighted row was chosen rather than merely first. */
    let commandSuggestionMoved = false;
    /** The argument values on offer, empty whenever the list is commands. */
    let argumentSuggestions: readonly string[] = [];
    /** Names an extension offers after an `@`, replaced wholesale. */
    let extensionMentions: readonly string[] = [];
    // Who an extension says the next message is going to. The client only
    // shows the name; it does not know what makes a message go there.
    let extensionAddressee: string | undefined;
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
    let sidebarPromptSubmitting = false;
    let extensionCommandsLoading =
        dependencies.client.listExtensionCommands !== undefined;
    let runningBackgroundAgents = 0;
    let runningBackgroundAgentNames: readonly string[] = [];
    let currentAgentHasParent = false;
    let stopWatchingBackgroundAgents: (() => void) | undefined;
    let pendingSessionRename: {
        readonly requestId: string;
        /** Restored to the composer if the rename never lands, when it came from one. */
        readonly commandText?: string;
    } | undefined;
    /**
     * Consults in flight, keyed by request. Several may run at once: an
     * extension with more than one seat asks them all in parallel.
     */
    const pendingConsults = new Map<string, {
        readonly resolve: (result: VeraClientConsultResult) => void;
        readonly reject: (reason: Error) => void;
    }>();
    /** Which extension holds the sidebar, absent while nobody does. */
    let sidebarOwner: string | undefined;
    let sidebarAgentPane: TuiAgentPane<IdentifiedTuiAgentClient> | undefined;
    let sidebarAttachmentLifetime: "ephemeral" | "durable" = "durable";
    let sidebarInitialApprovalMode: string | undefined;
    let sidebarAgentMention: string | undefined;
    let sidebarModeLabel: string | undefined;
    let clientSurfaceReady = false;
    let submitAfterImageAttachment = false;
    let pendingImages: Array<{
        requestId: string;
        path?: string;
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
    const configuredClientExtensions = [
        ...bundledClientExtensionConfigs(disabledBuiltinExtensions),
        ...(dependencies.clientExtensions ?? []),
    ];
    clientExtensionRegistry = await startClientExtensionRegistry({
        extensions: configuredClientExtensions,
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
        consult: {
            request: (_extensionId, request, signal) =>
                requestExtensionConsult(request, signal),
        },
        sidebar: {
            open(extensionId) {
                if (
                    sidebarOwner !== undefined && sidebarOwner !== extensionId
                ) {
                    throw new Error(`${sidebarOwner} is using the sidebar`);
                }
                sidebarOwner = extensionId;
                sidebar.setHeader(undefined);
                sidebar.open();
                renderState();
            },
            append(extensionId, block) {
                requireSidebarOwner(extensionId);
                sidebar.append(block.label, block.text, block.speaker);
                renderSidebarJump();
            },
            clear(extensionId) {
                requireSidebarOwner(extensionId);
                sidebar.clear();
            },
            close(extensionId) {
                requireSidebarOwner(extensionId);
                const attached = sidebarAgentPane;
                sidebarAgentPane = undefined;
                sidebarAgentMention = undefined;
                sidebarModeLabel = undefined;
                forgetPersistedAgentPane();
                void attached?.detach().catch(() => attached.close());
                sidebarOwner = undefined;
                clearSidebarEntryNodes();
                sidebar.setHeader(undefined);
                sidebar.close();
                renderState();
            },
        },
        mentions: {
            set(_extensionId, names) {
                extensionMentions = names;
                if (clientSurfaceReady) {
                    renderCommandSuggestions();
                }
            },
        },
        addressing: {
            set(_extensionId, name) {
                extensionAddressee = name;
                renderState();
            },
        },
        agents: {
            visible(_extensionId) {
                return [
                    ...(client.agentId === undefined
                        ? []
                        : [{ agentId: client.agentId, pane: "main" as const }]),
                    ...(sidebarAgentPane === undefined
                        ? []
                        : [{
                            agentId: sidebarAgentPane.agentId,
                            pane: "sidebar" as const,
                            ...(sidebarAgentMention === undefined
                                ? {}
                                : { mention: sidebarAgentMention }),
                        }]),
                ];
            },
            async create(extensionId, request, signal) {
                if (signal.aborted) throw signal.reason;
                if (dependencies.createAgent === undefined) {
                    throw new Error("This client cannot create agents");
                }
                const next = requireIdentifiedClient(await dependencies.createAgent(
                    request.workspace ?? client.workspace ?? process.cwd(),
                    request.approvalMode,
                    request.attachmentLifetime,
                ));
                await openExtensionAgent(
                    extensionId,
                    next,
                    request.pane,
                    false,
                    request.mention,
                    request.attachmentLifetime,
                    request.approvalMode,
                    request.statusLabel,
                );
                return { agentId: next.agentId };
            },
            async open(extensionId, request, signal) {
                if (signal.aborted) throw signal.reason;
                if (dependencies.attachAgent === undefined) {
                    throw new Error("This client cannot attach agents");
                }
                const next = requireIdentifiedClient(
                    await dependencies.attachAgent(request.agentId),
                );
                await openExtensionAgent(
                    extensionId,
                    next,
                    request.pane,
                    false,
                    request.mention,
                    request.attachmentLifetime,
                    undefined,
                    request.statusLabel,
                );
            },
            async message(_extensionId, request, signal) {
                if (signal.aborted) throw signal.reason;
                const side = request.agentId === sidebarAgentPane?.agentId
                    ? sidebarAgentPane
                    : undefined;
                if (side !== undefined) {
                    const attachments = await attachImagesToSidebar(
                        side,
                        request.imagePaths ?? [],
                        signal,
                    );
                    await side.client.send({
                        type: "prompt",
                        content: request.text,
                        ...(attachments.length === 0
                            ? {}
                            : {
                                attachmentIds: attachments.map(
                                    (attachment) => attachment.id,
                                ),
                            }),
                    });
                    return;
                }
                if (request.agentId !== client.agentId) {
                    throw new Error("Agent must be open before it can be messaged");
                }
                if ((request.imagePaths?.length ?? 0) > 0) {
                    throw new Error("Submitted images already belong to the main agent");
                }
                await client.send({ type: "prompt", content: request.text });
            },
        },
        thread: {
            read(_extensionId) {
                return state.entries
                    .filter((entry) =>
                        (entry.kind === "user" || entry.kind === "assistant")
                        && entry.text.length > 0)
                    .map((entry) => ({
                        role: entry.kind as "user" | "assistant",
                        text: entry.text,
                    }));
            },
        },
        transcript: {
            append(_extensionId, block) {
                state = appendTuiExtensionBlock(state, block.label, block.text);
                renderState();
            },
        },
        notice: {
            post(_extensionId, text) {
                state = appendTuiNotice(state, text);
                renderState();
            },
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
                state = appendTuiError(
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
    const coreHelpCommandNames = new Set(commandRegistry.commandNames());
    function coreHelpCommands(): readonly TuiCommandCatalogEntry[] {
        return commandRegistry.registeredCommands(coreHelpCommandNames);
    }

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
        "markup.raw": { fg: activeTheme.code },
        "markup.raw.block": { fg: activeTheme.code },
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
            paddingTop: 0,
            paddingBottom: 1,
            paddingLeft: 2,
            paddingRight: 2,
        },
    });

    const JUMP_TO_BOTTOM_LABEL =
        ` ↓ Jump to bottom · ${tuiKeyHint("jump_to_bottom")} `;
    const jumpToBottomText = new TextRenderable(renderer, {
        id: "jump-to-bottom-text",
        content: JUMP_TO_BOTTOM_LABEL,
        fg: theme.background,
        bg: theme.accent,
        width: "100%",
        height: 1,
    });
    const jumpToBottom = new BoxRenderable(renderer, {
        id: "jump-to-bottom",
        position: "absolute",
        width: JUMP_TO_BOTTOM_LABEL.length,
        height: 1,
        backgroundColor: theme.accent,
        zIndex: 4,
        visible: false,
        onMouseDown: () => {
            transcript.scrollTo(transcript.scrollHeight);
            renderJumpToBottom();
        },
    });
    jumpToBottom.add(jumpToBottomText);

    // The sidebar gets the same pill, shortened: the column is narrow, and the
    // key jumps the transcript, so there is nothing to name here but the way
    // back down.
    const SIDEBAR_JUMP_LABEL = " \u2193 Jump to bottom ";
    const sidebarJumpText = new TextRenderable(renderer, {
        id: "sidebar-jump-text",
        content: SIDEBAR_JUMP_LABEL,
        fg: theme.background,
        bg: theme.accent,
        width: "100%",
        height: 1,
    });
    const sidebarJump = new BoxRenderable(renderer, {
        id: "sidebar-jump",
        position: "absolute",
        width: SIDEBAR_JUMP_LABEL.length,
        height: 1,
        backgroundColor: theme.accent,
        zIndex: 4,
        visible: false,
        onMouseDown: () => {
            sidebar.scrollToBottom();
            renderJumpToBottom();
        },
    });
    sidebarJump.add(sidebarJumpText);

    const placeholder = new TextRenderable(renderer, {
        id: "placeholder",
        content: "Start a conversation with Vera.",
        fg: TUI_MUTED,
        width: "100%",
    });
    transcript.add(placeholder);

    // Parallel arrays: every push/pop on one must pair with the other. If they
    // drift, the kind-churn check in renderState compares against stale kinds
    // and tears down and rebuilds the transcript tail on every repaint, which
    // shows up as whole markdown blocks blanking for a frame while streaming
    // (recreated blocks paint nothing until the tree-sitter worker returns).
    const entryNodes: (TextRenderable | MarkdownRenderable | BoxRenderable)[] = [];
    const entryNodeKinds: TuiTranscriptEntry["kind"][] = [];
    const sidebarEntryNodes: (
        TextRenderable | MarkdownRenderable | BoxRenderable
    )[] = [];
    const sidebarEntryNodeKinds: TuiTranscriptEntry["kind"][] = [];
    let sidebarEntryGeneration = 0;

    function clearSidebarEntryNodes(): void {
        while (sidebarEntryNodes.length > 0) {
            sidebarEntryNodes.pop()?.destroy();
            sidebarEntryNodeKinds.pop();
        }
    }

    const statusText = new TextRenderable(renderer, {
        id: "status",
        content: READY_HINT,
        fg: TUI_MUTED,
        height: 1,
        flexShrink: 0,
        // On the last line of the place row rather than a line of its own: it
        // is the shortest thing down there and the row has the room.
        alignSelf: "flex-end",
    });
    const paneStatusText = new TextRenderable(renderer, {
        id: "pane-status",
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        visible: false,
    });
    const backgroundStatusText = new TextRenderable(renderer, {
        id: "background-status",
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: 2,
    });
    // The details sit in a panel of their own rather than loose under the
    // composer: the composer is where the session is typed into, and this is
    // what the session currently is. One border says the two are separate
    // things without a heading having to say it.
    const statusCard = new BoxRenderable(renderer, {
        id: "status-card",
        border: false,
        width: "100%",
        height: "auto",
        flexDirection: "column",
    });
    statusCard.add(backgroundStatusText);
    const workspaceBranch = watchWorkspaceBranch(
        process.cwd(),
        () => renderer.requestRender(),
    );
    // A text node paints only the cells its glyphs fill, so the status rows
    // would show the transcript through every gap in the line, and through the
    // spaces inside it. The band that backs them is this box rather than a
    // sibling behind them: a sibling is sized from the rows' heights, which say
    // nothing about whether the rows are drawn, so every surface that hid a
    // status row left the paint behind. Held together, hiding the rows hides
    // the band, and one height serves the composer's margin as well.
    const statusBand = new BoxRenderable(renderer, {
        id: "status-band",
        position: "absolute",
        left: 0,
        bottom: 0,
        width: "100%",
        height: "auto",
        flexDirection: "column",
        // The rows are indented from the band, not from themselves: a text
        // node laid out as a flex child does not carry its own padding. The
        // indent clears the frame above and its padding, so these rows start
        // in the same column as the text inside it.
        paddingLeft: 4,
        paddingRight: 4,
        zIndex: DIALOG_BACKGROUND_Z_INDEX,
    });
    // Where the session is on the left, what it is doing on the right, both
    // under the frame they belong to.
    const placeRow = new BoxRenderable(renderer, {
        id: "place-row",
        width: "100%",
        height: "auto",
        flexDirection: "row",
    });
    statusCard.flexGrow = 1;
    statusCard.flexShrink = 1;
    placeRow.add(statusCard);
    placeRow.add(statusText);
    statusBand.add(placeRow);
    statusBand.add(paneStatusText);

    // Read here rather than passed in: tips are a client-side display choice,
    // and the host has no say in them.
    const tipsConfig = loadOptionalVeraConfig();
    const tipsEnabled = tipsConfig === undefined
        || configuredTipsEnabled(tipsConfig);
    // Tips read their own launch counter on the way in, so the count advances
    // once per start no matter how many tips the run goes on to show.
    let tipState: TuiTipState = tipsEnabled
        ? beginTuiTipLaunch()
        : { launches: 0, history: {} };
    // The line above the composer, cleared on the next submit. The overlay's
    // own line is chosen separately: an overlay is a place the user went
    // looking for keys, so it is allowed a tip even when the transcript one
    // has already been spent this turn.
    let composerTip: string | undefined;
    let workingLastRender = false;
    let pickerTipKind: string | undefined;

    const composerTipText = new TextRenderable(renderer, {
        id: "composer-tip",
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        paddingLeft: 2,
        visible: false,
    });

    // Text taken from one pane and waiting to ride along with the next
    // message. One at a time: a second selection replaces it, which is what a
    // person who selects again means.
    let pendingQuote: TuiQuote | undefined;

    const quoteText = new TextRenderable(renderer, {
        id: "pending-quote",
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        visible: false,
    });
    // Quote controls are footer state for the shared composer. Keeping them in
    // the status band puts them below the input regardless of which pane the
    // quoted text came from.
    statusBand.add(quoteText);

    const heldAddressText = new TextRenderable(renderer, {
        id: "held-address",
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        visible: false,
    });

    const queuedPromptText = new TextRenderable(renderer, {
        id: "queued-prompt",
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        visible: false,
    });

    const composer = createTuiComposer(
        renderer,
        // Called with the editor's value, which is not what submitPrompt's
        // parameter means.
        () => submitPrompt(),
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
    const namePromptView = createTuiNamePromptView(renderer);
    const preferencesListView = createTuiPreferencesListView(renderer);
    const commandPaletteView = createTuiCommandPaletteView(renderer);
    const helpView = createTuiHelpView(renderer);
    const diagnosticsDialogView = createTuiDiagnosticsDialogView(renderer);
    const permissionsConfirmView = createTuiPermissionsConfirmView(renderer);
    const admissionDialogView = createTuiAdmissionDialogView(renderer);
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
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 7,
        height: 1,
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: theme.background,
        zIndex: 5,
        visible: false,
    });
    commandSuggestionsBox.add(commandSuggestionsText);
    composer.onContentChange = renderCommandSuggestions;

    /**
     * How many rows the status band takes under the composer. The suggestion
     * strip floats outside the layout flow and has to clear that band, so the
     * margin is kept here rather than read back off the box.
     */
    let composerMarginRows = 2;

    function setComposerMargin(rows: number): void {
        composerMarginRows = rows;
        composerBox.marginBottom = rows;
        positionCommandSuggestions();
    }

    function positionCommandSuggestions(): void {
        commandSuggestionsBox.bottom = TUI_COMPOSER_PANEL_ROWS
            + composerMarginRows
            + (composerTipText.visible ? 1 : 0)
            + (quoteText.visible ? 1 : 0)
            + (heldAddressText.visible ? 1 : 0);
    }

    const modeToastText = new TextRenderable(renderer, {
        id: "mode-toast-text",
        content: "",
        fg: theme.text,
        bg: theme.panel,
        width: "100%",
        height: 1,
    });
    const modeToast = new BoxRenderable(renderer, {
        id: "mode-toast",
        position: "absolute",
        // Positioned against the shared app, not either pane, with enough
        // inset to read as a floating notice rather than terminal chrome.
        top: 1,
        right: 2,
        width: 1,
        height: 3,
        paddingTop: 1,
        paddingBottom: 1,
        paddingLeft: 2,
        paddingRight: 2,
        backgroundColor: theme.panel,
        zIndex: 4,
        visible: false,
    });
    modeToast.add(modeToastText);
    let modeToastVersion = 0;

    const {
        panel: composerBox,
        status: composerStatusText,
        rule: composerRule,
    } = createTuiComposerPanel(renderer, composer);

    const bodyFocus = new TuiBodyFocusController();
    // Everything the sidebar sits beside: the conversation and what hangs off
    // it, but not the composer, so the split ends where typing begins.
    const upper = new BoxRenderable(renderer, {
        id: "upper",
        flexGrow: 1,
        flexDirection: "column",
        gap: 1,
    });
    const app = new BoxRenderable(renderer, {
        id: "app",
        width: "100%",
        height: "100%",
        flexDirection: "column",
        // The whole screen carries the theme's background. Painting it here
        // rather than under the surfaces that need it is what keeps a strip of
        // a different shade from showing wherever one of them is hidden.
        backgroundColor: theme.background,
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
    const sidebar = createTuiSidebar({
        renderer,
        transcript: upper,
        theme: sidebarTheme(),
        syntaxStyle: markdownStyle,
        ...(sidebarWidth === undefined ? {} : { initialWidth: sidebarWidth }),
        onWidthChanged: (columns) => {
            try {
                saveTuiSidebarWidth(columns);
            } catch {
                // A width that could not be saved is not worth interrupting a
                // drag over; the sidebar keeps it for this session.
            }
        },
        onPanelRelease: () => {
            if (sidebarAgentPane === undefined || anyOverlayOpen()) return;
            // Pointer input never chooses the addressed agent; Ctrl+G owns
            // that. It does return typing focus after either transcript is
            // clicked or selected, matching the main pane.
            composer.focus();
            renderState();
        },
        // Clicking the column is how you talk to it: with one seat there is no
        // question who, and typing the name again is the part nobody wants.
        onPanelClick: () => {
            if (sidebarAgentPane !== undefined) {
                return;
            }
            const first = visibleMentions()[0];
            if (first === undefined) return;
            // Already addressing someone (even with a trailing space): a
            // second click must not stack another mention.
            if (/(?:^|\s)@\S*\s*$/.test(composer.plainText)) return;
            composer.setComposerText(
                composer.plainText.length === 0
                    ? `@${first} `
                    : `${composer.plainText} @${first} `,
            );
            sidebar.setFocused(true);
            composer.focus();
            renderCommandSuggestions();
            renderState();
        },
        onLayoutChanged: () => {
            reflowTranscriptSeparators();
            renderJumpToBottom();
            renderSidebarJump();
            renderCommandSuggestions();
        },
    });

    async function openExtensionAgent(
        extensionId: string,
        next: IdentifiedTuiAgentClient,
        pane: "main" | "sidebar",
        replaceSidebarOwner = false,
        mention?: string,
        attachmentLifetime: "ephemeral" | "durable" = "durable",
        initialApprovalMode?: string,
        statusLabel?: string,
    ): Promise<void> {
        if (pane === "main") {
            switchToClient(next, undefined, { preserveSidebar: true });
            return;
        }
        if (
            !replaceSidebarOwner
            && sidebarAgentPane === undefined
            && sidebarOwner !== undefined
            && sidebarOwner !== extensionId
        ) {
            next.close();
            throw new Error(`${sidebarOwner} is using the sidebar`);
        }
        const previous = sidebarAgentPane;
        const previousModeLabel = sidebarModeLabel;
        sidebarAgentPane = undefined;
        await previous?.detach();
        sidebarOwner = extensionId;
        const attached = new TuiAgentPane({
            client: next,
            onUpdate: (update, current) => {
                handleSidebarAgentUpdate(update, current);
                renderSidebarAgent(current);
                if (
                    update.type === "ui_request"
                    || update.type === "ui_request_closed"
                ) {
                    focusActiveSurface();
                }
            },
            onFailure: (error, current) => {
                if (current !== sidebarAgentPane) return;
                sidebar.append("agent", `Connection failed: ${error.message}`);
                renderState();
            },
        });
        sidebarAgentPane = attached;
        sidebarAttachmentLifetime = attachmentLifetime;
        sidebarInitialApprovalMode = initialApprovalMode
            ?? sidebarInitialApprovalMode;
        sidebarAgentMention = mention ?? attached.agentId;
        sidebarModeLabel = statusLabel;
        rememberOpenPaneGroup();
        clearSidebarEntryNodes();
        sidebar.clear();
        sidebar.setHeader(undefined);
        sidebar.open();
        sidebar.setFocused(true);
        attached.start();
        requestAgentSettings(next);
        renderState();
        if (
            previousModeLabel !== undefined
            && statusLabel !== undefined
            && previousModeLabel !== statusLabel
        ) {
            showModeToast(
                `Switched from ${displayModeLabel(previousModeLabel)} to ${displayModeLabel(statusLabel)} mode`,
            );
        }
    }

    function focusedAgentClient(): TuiAgentClient {
        return sidebar.isFocused() && sidebarAgentPane !== undefined
            ? sidebarAgentPane.client
            : client;
    }

    function focusedAgentState(): TuiState {
        return sidebar.isFocused() && sidebarAgentPane !== undefined
            ? sidebarAgentPane.state.state
            : state;
    }

    function focusedUiRequest(): UiRequestUpdate | undefined {
        return sidebar.isFocused() && sidebarAgentPane !== undefined
            ? sidebarAgentPane.state.pendingUiRequest
            : pendingUiRequest;
    }

    function focusedAbortRequested(): boolean {
        return sidebar.isFocused() && sidebarAgentPane !== undefined
            ? sidebarAgentPane.state.abortRequested
            : abortRequested;
    }

    function abortFocusedAgent(): void {
        if (sidebar.isFocused() && sidebarAgentPane !== undefined) {
            sidebarAgentPane.state.abortRequested = true;
            sidebarAgentPane.state.activity = "stopping";
            void sidebarAgentPane.client.send({ type: "abort" })
                .catch(reportConnectionError);
            return;
        }
        abortRequested = true;
        activity = "stopping";
        sendCommand({ type: "abort" });
    }

    function visibleMentions(): readonly string[] {
        if (sidebarAgentPane === undefined || sidebarAgentMention === undefined) {
            return extensionMentions;
        }
        return [sidebarAgentMention, "all", "vera"];
    }

    function sidebarTranscriptWidth(): number {
        return Math.max(
            1,
            (sidebar.layout() === "sidebar"
                ? renderer.terminalWidth - 1
                : sidebar.width()) - 2,
        );
    }

    function mainTranscriptWidth(): number {
        return Math.max(
            1,
            renderer.terminalWidth
                - (sidebar.isShown() ? sidebar.width() + 1 : 0)
                - 4,
        );
    }

    /** Rebuild width-sensitive rules after either pane changes geometry. */
    function reflowTranscriptSeparators(): void {
        state.entries.forEach((entry, index) => {
            const node = entryNodes[index];
            if (
                node instanceof MarkdownRenderable
                && assistantFollowsWork(state.entries, index)
            ) {
                node.content = tuiMarkdownEntryContent(
                    entry,
                    true,
                    mainTranscriptWidth(),
                );
            }
        });
        const side = sidebarAgentPane;
        if (side === undefined) return;
        side.state.state.entries.forEach((entry, index) => {
            const node = sidebarEntryNodes[index];
            if (
                node instanceof MarkdownRenderable
                && assistantFollowsWork(side.state.state.entries, index)
            ) {
                node.content = tuiMarkdownEntryContent(
                    entry,
                    true,
                    sidebarTranscriptWidth(),
                );
            }
        });
    }

    function rememberOpenPaneGroup(): void {
        const mainId = client.agentId;
        const sidebarId = sidebarAgentPane?.agentId;
        if (mainId === undefined || sidebarId === undefined) return;
        if (sidebarAttachmentLifetime === "ephemeral") {
            sharedSessionGroups = sharedSessionGroups.filter((group) =>
                !group.includes(mainId) && !group.includes(sidebarId)
            );
            try {
                saveTuiSharedSessionGroups(sharedSessionGroups);
                if (client.agentId !== undefined) {
                    saveTuiPersistedAgentPane(client.agentId, undefined);
                }
            } catch {
                // A failed UI preference write must not prevent an attachment.
            }
            return;
        }
        sharedSessionGroups = [
            ...sharedSessionGroups.filter((group) =>
                !group.includes(mainId) && !group.includes(sidebarId)
            ),
            [mainId, sidebarId] as const,
        ];
        try {
            saveTuiSharedSessionGroups(sharedSessionGroups);
            saveTuiPersistedAgentPane(mainId, {
                mainAgentId: mainId,
                sidebarAgentId: sidebarId,
                owner: sidebarOwner ?? "vera.tui.agent-attachments",
                ...(sidebarAgentMention === undefined
                    ? {}
                    : { mention: sidebarAgentMention }),
                ...(sidebarModeLabel === undefined
                    ? {}
                    : { statusLabel: sidebarModeLabel }),
            });
        } catch {
            // A failed UI preference write must not prevent an attachment.
        }
    }

    function forgetPersistedAgentPane(mainAgentId = client.agentId): void {
        if (mainAgentId === undefined) return;
        try {
            saveTuiPersistedAgentPane(mainAgentId, undefined);
        } catch {
            // A failed preference cleanup cannot block closing a pane.
        }
    }

    function renderSidebarAgent(
        pane: TuiAgentPane<IdentifiedTuiAgentClient>,
    ): void {
        if (pane !== sidebarAgentPane) return;
        const entries = pane.state.state.entries;
        const changedKindAt = entries.findIndex((entry, index) =>
            sidebarEntryNodes[index] !== undefined
            && sidebarEntryNodeKinds[index] !== entry.kind
        );
        const retained = changedKindAt === -1
            ? Math.min(entries.length, sidebarEntryNodes.length)
            : changedKindAt;
        const discarded = sidebarEntryNodes.splice(retained);
        sidebarEntryNodeKinds.splice(retained);

        entries.forEach((entry, index) => {
            const existing = sidebarEntryNodes[index];
            if (existing !== undefined) {
                existing.visible = entry.kind !== "tool" || entry.hidden !== true;
                if (
                    existing instanceof MarkdownRenderable
                    && existing.content !== tuiMarkdownEntryContent(
                        entry,
                        assistantFollowsWork(entries, index),
                        sidebarTranscriptWidth(),
                    )
                ) {
                    existing.content = tuiMarkdownEntryContent(
                        entry,
                        assistantFollowsWork(entries, index),
                        sidebarTranscriptWidth(),
                    );
                } else if (
                    entry.kind === "tool"
                    && existing instanceof BoxRenderable
                ) {
                    updateTuiToolRow(existing, entry);
                } else if (
                    entry.kind === "tool_header"
                    && existing instanceof BoxRenderable
                ) {
                    updateTuiToolHeader(existing, entry);
                } else if (
                    (entry.kind === "thought"
                        || entry.kind === "thinking"
                        || entry.kind === "notice"
                        || entry.kind === "inbox")
                    && existing instanceof TextRenderable
                ) {
                    existing.content = renderTuiEntry(entry);
                }
                return;
            }

            const id = `sidebar-entry-${++sidebarEntryGeneration}`;
            const marginTop = tuiEntryMarginTop(entries, index);
            const separatedAssistant = assistantFollowsWork(entries, index);
            const markdownNode = entry.kind === "diff"
                ? undefined
                : createTuiMarkdownEntry(
                    renderer,
                    id,
                    entry,
                    markdownStyle,
                    TUI_TEXT,
                    marginTop,
                    separatedAssistant,
                    sidebarTranscriptWidth(),
                );
            const node = entry.kind === "tool"
                ? createTuiToolRow(renderer, id, entry, marginTop)
                : entry.kind === "tool_header"
                ? createTuiToolHeader(renderer, id, entry, marginTop)
                : entry.kind === "user"
                ? createTuiUserEntry(renderer, id, entry, marginTop)
                : entry.kind === "diff"
                ? createTuiDiff(
                    renderer,
                    id,
                    tuiDisplayPath(entry.path),
                    entry.patch,
                    markdownStyle,
                    marginTop,
                )
                : markdownNode ?? new TextRenderable(renderer, {
                    id,
                    content: renderTuiEntry(entry),
                    width: "100%",
                    wrapMode: "word",
                    selectable: true,
                    marginTop,
                });
            node.visible = entry.kind !== "tool" || entry.hidden !== true;
            sidebarEntryNodes.push(node);
            sidebarEntryNodeKinds.push(entry.kind);
        });
        sidebar.replaceRendered(sidebarEntryNodes.map((node, index) => ({
            node,
            speaker: entries[index]?.kind === "user" ? "you" : "agent",
        })));
        for (const node of discarded) node.destroy();
        renderSidebarJump();
        renderState();
    }

    function handleSidebarAgentUpdate(
        update: AgentUpdate,
        pane: TuiAgentPane<IdentifiedTuiAgentClient>,
    ): void {
        if (pane !== sidebarAgentPane) return;
        if (update.type === "ui_request") {
            sidebar.setFocused(true);
        }
        if (update.type === "turn_finished") {
            pane.state.state = beginNextQueuedTuiTurn(pane.state.state);
            if (pane.state.state.working) {
                pane.state.workingSince = Date.now();
                pane.state.phaseSince = pane.state.workingSince;
                pane.state.activity = "thinking";
            } else {
                pane.state.workingSince = undefined;
                pane.state.phaseSince = undefined;
                pane.state.activity = "ready";
            }
        }
        if (update.type === "model_settings") {
            requestedModelChanges.delete(update.requestId);
        } else if (update.type === "model_settings_rejected") {
            const subject = requestedModelChanges.get(update.requestId);
            requestedModelChanges.delete(update.requestId);
            if (subject !== undefined) {
                pane.state.state = appendTuiError(
                    pane.state.state,
                    rejectionNotice(subject, update.reason),
                );
            }
        } else if (update.type === "permissions") {
            requestedPermissionChanges.delete(update.requestId);
        } else if (update.type === "permissions_rejected") {
            const subject = requestedPermissionChanges.get(update.requestId);
            requestedPermissionChanges.delete(update.requestId);
            if (subject !== undefined) {
                pane.state.state = appendTuiError(
                    pane.state.state,
                    rejectionNotice(subject, update.reason),
                );
            }
        }
    }
    upper.add(transcript);
    app.add(sidebar.body);
    app.add(jumpToBottom);
    app.add(sidebarJump);
    app.add(modeToast);
    const overlayScrim = new BoxRenderable(renderer, {
        id: "overlay-scrim",
        position: "absolute",
        width: "100%",
        height: "100%",
        backgroundColor: RGBA.fromInts(0, 0, 0, 210),
        zIndex: DIALOG_SCRIM_Z_INDEX,
        visible: false,
    });
    app.add(overlayScrim);
    upper.add(queuedPromptText);
    app.add(commandSuggestionsBox);
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
    settingsPickerView.onTab = (tab) => {
        // The strip is on screen on the connect pane too, and a chip on it
        // leaves that pane for the collection it names.
        const pane = settingsPicker?.kind === "provider"
            ? settingsPicker.parent
            : settingsPicker;
        if (pane === undefined || pane.kind !== "model") {
            return;
        }
        settingsPicker = switchedModelTab(pane, tab);
        renderState();
    };
    settingsPickerView.onConfigure = () => {
        if (settingsPicker?.kind === "provider") return;
        if (settingsPicker?.kind !== "model") return;
        openProviderPicker(settingsPicker);
    };
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
    app.add(namePromptView.box);
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
    app.add(diagnosticsDialogView.box);
    app.add(permissionsConfirmView.box);
    app.add(admissionDialogView.box);
    app.add(sessionTrashConfirmView.box);
    app.add(composerTipText);
    // Pinned beside the composer, not written into the transcript: a mode the
    // transcript announces is a mode that scrolls out of sight.
    app.add(heldAddressText);
    app.add(composerBox);
    app.add(statusBand);
    renderer.root.add(app);
    clientSurfaceReady = true;
    composer.focus();
    renderStatus();

    renderer.on(CliRenderEvents.DESTROY, () => {
        shuttingDown = true;
        renderCoalescer.stop();
        clearInterval(statusTimer);
        stopWatchingBackgroundAgents?.();
        stopWatchingBackgroundAgents = undefined;
        const picker = pendingExtensionPicker;
        pendingExtensionPicker = undefined;
        picker?.removeAbortListener();
        picker?.resolve({ outcome: "cancelled" });
        for (const pending of pendingExtensionSettings.values()) {
            pending.removeAbortListener();
            pending.reject(new Error("TUI is closing"));
        }
        pendingExtensionSettings.clear();
        const attachedSidebar = sidebarAgentPane;
        sidebarAgentPane = undefined;
        sidebarAgentMention = undefined;
        sidebarModeLabel = undefined;
        void Promise.all([
            Promise.resolve(clientExtensionRegistry?.close()),
            attachedSidebar?.detach(),
        ])
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

    /** The column's share of whichever theme is current. */
    function sidebarTheme() {
        return {
            handle: tuiHandleColor(theme),
            handleActive: tuiHandleActiveColor(theme),
            muted: theme.muted,
            text: theme.text,
        };
    }

    const renderCoalescer = createRenderCoalescer({ render: renderState });

    const statusTimer = setInterval(() => {
        renderStatus();
    }, activityAnimation === "shimmer"
        ? activityAnimationInterval ?? SHIMMER_FRAME_INTERVAL_MS
        : STATUS_REFRESH_INTERVAL_MS);
    watchBackgroundAgents(dependencies.client);

    renderer.on(CliRenderEvents.RESIZE, () => {
        sidebar.refit();
        renderState();
    });
    renderer.on(CliRenderEvents.SELECTION, (selection: Selection) => {
        const uiRequest = focusedUiRequest();
        const copyableNodes = uiRequest !== undefined
                && isToolApprovalUiRequestUpdate(uiRequest)
            ? [approvalView.detailsText]
            : uiRequest !== undefined
                    && isUserQuestionUiRequestUpdate(uiRequest)
                ? [questionView.detailsText]
                : entryNodes;
        const quotable = [
            ...state.entries.flatMap((entry, index) => {
                const node = entryNodes[index];
                return node === undefined ? [] : [{
                    node,
                    // Quoting the user's own words back is a different act
                    // from quoting the agent, and the attribution has to say
                    // which one happened.
                    speaker: entry.kind === "user" ? "you" : "agent",
                }];
            }),
            ...sidebar.blocks(),
        ];
        if (isTranscriptSelection(selection, [...copyableNodes, ...sidebar
            .blocks().map((block) => block.node)])) {
            void copyTranscriptSelection(selection);
        }
        const speaker = selectionSpeaker(selection, quotable);
        const selected = speaker === undefined ? "" : selection.getSelectedText();
        // Only while an extension has somewhere to send it. With nobody else
        // in the conversation, quoting hands the agent its own words back,
        // and arming every plain copy with a quote changes what the next
        // message says without the sender asking for it.
        if (
            visibleMentions().length > 0 && speaker !== undefined
            && selected.trim().length > 0
        ) {
            pendingQuote = { source: speaker, text: selected };
            // A drag leaves the composer unfocused, which is right when the
            // selection was only a copy. It has just become the start of a
            // message, so the next keystroke has to land in the composer.
            if (!anyOverlayOpen()) {
                composer.focus();
            }
            renderState();
        }
    });

    // The composer takes pastes through its own renderable handler, but the
    // secret prompt is a plain box drawn over whatever is behind it, so the
    // paste has to be routed here. Ahead of the composer, which would otherwise
    // end up with the key as visible text in the transcript.
    renderer.keyInput.on("paste", (event) => {
        if (
            namePrompt !== undefined
            && namePromptView.box.visible
        ) {
            event.preventDefault();
            event.stopPropagation();
            namePrompt = handleTuiNamePromptPaste(
                namePrompt,
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
            if (!sessionSwitchPending && !anyOverlayOpen()) {
                openCommandPalette();
            }
            return;
        }
        if (parseRawInputEvent(key)?.type === "interrupt") {
            // A trash in flight still consumes ctrl+c: it is destructive, it
            // is bounded by its own deadline, and the confirmation card is on
            // screen. A pending session switch does not, because the switch
            // has no cancel and swallowing the chord left no way to quit a
            // host that was slow to answer.
            if (sessionTrashPending) {
                key.preventDefault();
                key.stopPropagation();
                return;
            }
            if (
                !focusedAgentState().working
                && composer.focused
                && composer.plainText.length > 0
                && !anyOverlayOpen()
            ) {
                key.preventDefault();
                key.stopPropagation();
                composer.clearComposer();
                renderCommandSuggestions();
                renderState();
                return;
            }
            const action = tuiInterruptAction(
                key,
                focusedAgentState().working,
                focusedAbortRequested(),
            );
            key.preventDefault();
            key.stopPropagation();
            if (action === "quit") {
                renderer.destroy();
            } else if (action === "abort") {
                abortFocusedAgent();
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

        const uiRequest = focusedUiRequest();
        if (
            uiRequest !== undefined
            && isUserQuestionUiRequestUpdate(uiRequest)
        ) {
            // Arrow keys move the highlight (no engine message); numbers, Enter,
            // and Escape resolve the question. Selection stays client-local.
            const result = questionView.handleKey(uiRequest, key);
            if (result.handled) {
                key.preventDefault();
                key.stopPropagation();
                if (result.response !== undefined) {
                    void focusedAgentClient().send(result.response)
                        .catch(reportConnectionError);
                    if (sidebar.isFocused() && sidebarAgentPane !== undefined) {
                        sidebarAgentPane.state.activity = "thinking";
                    } else {
                        activity = "thinking";
                    }
                    focusActiveSurface();
                }
                renderState();
                return;
            }
        } else if (
            uiRequest !== undefined
            && isToolApprovalUiRequestUpdate(uiRequest)
        ) {
            // ←/→ move the button highlight (no engine message); digits, Enter,
            // and Escape resolve the approval. Selection stays client-local.
            const result = approvalView.handleKey(uiRequest, key);
            if (result.handled) {
                key.preventDefault();
                key.stopPropagation();
                if (result.response !== undefined) {
                    void focusedAgentClient().send(result.response)
                        .catch(reportConnectionError);
                    if (sidebar.isFocused() && sidebarAgentPane !== undefined) {
                        sidebarAgentPane.state.activity = "thinking";
                    } else {
                        activity = "thinking";
                    }
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
                    requestPermissionsChange(
                        "full_access",
                        confirmingFullAccessAgent,
                    );
                } else {
                    state = appendTuiNotice(state, "full access unchanged");
                }
                confirmingFullAccessAgent = undefined;
                focusActiveSurface();
                renderState();
                return;
            }
        }

        // Blocking like the trash confirm: every key stops here while the
        // dialog is up, so nothing underneath can act on a stray press.
        if (admissionDialog !== undefined) {
            key.preventDefault();
            key.stopPropagation();
            const action = handleTuiAdmissionDialogKey(
                admissionDialog,
                dialogAdmission(),
                key,
            );
            if (action === undefined) {
                return;
            }
            if (action === "retry") {
                const requestId = requestPoolAdmission(
                    admissionDialog.provider,
                    admissionDialog.model,
                    true,
                );
                admissionDialog = { ...admissionDialog, requestId };
                renderState();
                return;
            }
            if (action === "hide") {
                // The probes keep running; the transcript notice is their
                // surface from here.
                closeAdmissionDialog(false);
                return;
            }
            // Dismissing after an "added" verdict reopens the picker rebuilt
            // from the refreshed pool, which is where the new row now lives.
            closeAdmissionDialog(dialogAdmission()?.verdict === "added");
            return;
        }

        // Ahead of the picker: the prompt is drawn over the pane that opened
        // it, so it takes the keys while it is up.
        if (namePrompt !== undefined) {
            const transition = handleTuiNamePromptKey(
                namePrompt,
                key,
            );
            if (transition.handled) {
                key.preventDefault();
                key.stopPropagation();
                applySessionRenamePromptTransition(
                    namePrompt,
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

        if (diagnosticsDialog !== undefined) {
            const action = handleTuiDiagnosticsDialogKey(key);
            if (action !== undefined) {
                key.preventDefault();
                key.stopPropagation();
                if (action === "dismiss") {
                    diagnosticsDialog = undefined;
                    focusActiveSurface();
                    renderState();
                    return;
                }
                if (diagnosticsDialog.copyReady === false) {
                    return;
                }
                const text = diagnosticsDialog.text;
                void copyText(text).then(() => {
                    if (diagnosticsDialog?.text !== text) return;
                    diagnosticsDialog = { text, copyStatus: "copied" };
                    renderState();
                }).catch(() => {
                    if (diagnosticsDialog?.text !== text) return;
                    diagnosticsDialog = { text, copyStatus: "failed" };
                    renderState();
                });
                return;
            }
        }

        if (
            argumentSuggestions.length > 0
            && commandSuggestionsBox.visible
            && !key.ctrl
            && !key.meta
            && !key.super
            && !key.hyper
            && !key.shift
        ) {
            if (key.name === "up" || key.name === "down") {
                key.preventDefault();
                key.stopPropagation();
                commandSuggestionIndex = key.name === "up"
                    ? Math.max(0, commandSuggestionIndex - 1)
                    : Math.min(
                        argumentSuggestions.length - 1,
                        commandSuggestionIndex + 1,
                    );
                renderCommandSuggestions();
                return;
            }
            if (key.name === "return" || key.name === "enter") {
                const typed = activeCompletion()?.prefix;
                const selected = argumentSuggestions[commandSuggestionIndex];
                // Already typed whole: there is nothing left to choose, so
                // Enter sends the command instead of re-inserting the name.
                if (
                    selected !== undefined
                    && selected.toLowerCase() !== typed?.toLowerCase()
                ) {
                    key.preventDefault();
                    key.stopPropagation();
                    // Chosen, not sent: the rest of the command is still
                    // being typed.
                    composer.setComposerText(
                        tuiWithArgument(composer.plainText, selected),
                    );
                    renderCommandSuggestions();
                    return;
                }
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
                commandSuggestionMoved = true;
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
                commandSuggestionMoved = true;
                renderCommandSuggestions();
                return;
            }
            const runs = key.name === "return" || key.name === "enter";
            const completes =
                tuiBindingId("composer", key) === "complete_command";
            if (runs || (completes && commandSuggestionMoved)) {
                const selected = suggestions[commandSuggestionIndex];
                if (selected !== undefined) {
                    key.preventDefault();
                    key.stopPropagation();
                    composer.setComposerText(`/${selected.name}`);
                    // Completing picks the command and leaves it there, since
                    // one that takes an argument is not finished being typed.
                    if (runs) submitPrompt();
                    return;
                }
            }
        }

        // Ahead of clearing the composer, so dropping a quote does not also
        // throw away the message being written to send it with.
        if (
            key.name === "escape"
            && !key.ctrl
            && !key.shift
            && !key.meta
            && pendingQuote !== undefined
        ) {
            key.preventDefault();
            key.stopPropagation();
            pendingQuote = undefined;
            renderState();
            composer.focus();
            return;
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
            const completing = activeCompletion();
            if (completing !== undefined) {
                key.preventDefault();
                key.stopPropagation();
                // A highlighted row is a choice already made with the arrow
                // keys, so Tab takes it rather than typing the shared prefix
                // of rows the user has already moved past.
                const highlighted = argumentSuggestions[commandSuggestionIndex];
                if (
                    highlighted !== undefined
                    && highlighted.toLowerCase()
                        !== completing.prefix.toLowerCase()
                ) {
                    composer.setComposerText(
                        tuiWithArgument(composer.plainText, highlighted),
                    );
                    renderCommandSuggestions();
                    return;
                }
                const completed = tuiArgumentCompletion(
                    completing.values,
                    completing.prefix,
                );
                if (completed !== undefined) {
                    composer.setComposerText(
                        tuiWithArgument(composer.plainText, completed),
                    );
                    renderCommandSuggestions();
                }
                return;
            }
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
            tuiBindingId("global", key) === "cycle_agent_layout"
            && sidebar.isOpen()
            && !anyOverlayOpen()
        ) {
            key.preventDefault();
            key.stopPropagation();
            sidebar.cycleLayout();
            composer.focus();
            renderState();
            return;
        }

        if (
            tuiBindingId("global", key) === "switch_agent_pane"
            && sidebarAgentPane !== undefined
            && sidebar.layout() === "split"
            && !anyOverlayOpen()
        ) {
            key.preventDefault();
            key.stopPropagation();
            sidebar.setFocused(!sidebar.isFocused());
            composer.focus();
            renderState();
            return;
        }

        if (
            tuiBindingId("global", key) === "toggle_thinking"
            && !anyOverlayOpen()
        ) {
            key.preventDefault();
            key.stopPropagation();
            const side = sidebar.isFocused() ? sidebarAgentPane : undefined;
            const wasFollowing = side === undefined
                ? transcript.scrollTop
                    >= transcript.scrollHeight - transcript.viewport.height
                : sidebar.isFollowing();
            if (side === undefined) {
                state = toggleTuiThinking(state);
            } else {
                side.state.state = toggleTuiThinking(side.state.state);
                renderSidebarAgent(side);
            }
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
            const activeState = side?.state.state ?? state;
            const lastThought = activeState.entries.findLastIndex((entry) =>
                entry.kind === "thought"
            );
            if (wasFollowing) {
                if (side === undefined) {
                    transcript.scrollTo(transcript.scrollHeight);
                } else {
                    sidebar.scrollToBottom();
                }
            } else if (side === undefined && lastThought >= 0) {
                transcript.scrollChildIntoView(`entry-${lastThought}`);
            }
            return;
        }

        if (
            tuiBindingId("global", key) === "open_model_picker"
            && !anyOverlayOpen()
        ) {
            key.preventDefault();
            key.stopPropagation();
            openModelPicker();
            return;
        }

        if (
            tuiBindingId("conversation", key) === "toggle_tool_details"
            && !anyOverlayOpen()
        ) {
            key.preventDefault();
            key.stopPropagation();
            // Read this before the fold changes the transcript height. Once
            // expanded, the old bottom can look like a manually scrolled view.
            const side = sidebar.isFocused() ? sidebarAgentPane : undefined;
            const wasFollowing = side === undefined
                ? transcript.scrollTop
                    >= transcript.scrollHeight - transcript.viewport.height
                : sidebar.isFollowing();
            if (side === undefined) {
                state = toggleTuiToolDetails(state);
            } else {
                side.state.state = toggleTuiToolDetails(side.state.state);
                renderSidebarAgent(side);
            }
            renderState();
            if (wasFollowing) {
                if (side === undefined) {
                    transcript.scrollTo(transcript.scrollHeight);
                } else {
                    sidebar.scrollToBottom();
                }
            } else {
                const activeState = side?.state.state ?? state;
                const lastToolGroup = activeState.entries.findLastIndex((entry) =>
                    entry.kind === "tool_header"
                    && entry.detailLines !== undefined
                );
                if (side === undefined && lastToolGroup >= 0) {
                    transcript.scrollChildIntoView(`entry-${lastToolGroup}`);
                }
            }
            return;
        }

        const scrollBinding = anyOverlayOpen()
            ? undefined
            : tuiBindingId("conversation", key);
        const scrollLines = scrollBinding === "scroll_line_up"
            ? -1
            : scrollBinding === "scroll_line_down"
            ? 1
            : scrollBinding === "scroll_half_page_up"
            ? -Math.max(1, Math.floor(transcript.viewport.height / 2))
            : scrollBinding === "scroll_half_page_down"
            ? Math.max(1, Math.floor(transcript.viewport.height / 2))
            : undefined;
        if (scrollBinding === "jump_to_bottom" || scrollLines !== undefined) {
            key.preventDefault();
            key.stopPropagation();
            if (scrollLines === undefined) {
                transcript.scrollTo(transcript.scrollHeight);
            } else {
                transcript.scrollBy(scrollLines);
            }
            renderJumpToBottom();
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

        const action = tuiInterruptAction(
            key,
            focusedAgentState().working,
            focusedAbortRequested(),
        );
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
            abortFocusedAgent();
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
        let hoverTimer: ReturnType<typeof setTimeout> | undefined;
        return {
            hover: (index) => {
                clearTimeout(hoverTimer);
                hoverTimer = setTimeout(() => {
                    hoverTimer = undefined;
                    if (shuttingDown) return;
                    moveCursor(index);
                    renderState();
                }, POINTER_HOVER_DELAY_MS);
            },
            activate: (index) => {
                clearTimeout(hoverTimer);
                hoverTimer = undefined;
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
    function requestAgentSettings(target: TuiAgentClient): void {
        void target.send({
            type: "get_model_settings",
            requestId: randomUUID(),
        }).catch(reportConnectionError);
        void target.send({
            type: "get_permissions",
            requestId: randomUUID(),
        }).catch(reportConnectionError);
    }

    function requestSessionSettings(): void {
        requestAgentSettings(client);
    }

    void receiveAgentUpdates();
    void loadExtensionCommands();
    requestSessionSettings();
    void restorePersistedAgentPane();

    async function restorePersistedAgentPane(): Promise<void> {
        const mainAgentId = client.agentId;
        const saved = mainAgentId === undefined
            ? undefined
            : loadTuiPersistedAgentPane(mainAgentId);
        if (
            mainAgentId === undefined
            || saved === undefined
            || saved.mainAgentId !== mainAgentId
            || dependencies.attachAgent === undefined
        ) {
            return;
        }
        try {
            const next = requireIdentifiedClient(
                await dependencies.attachAgent(saved.sidebarAgentId),
            );
            if (shuttingDown || client.agentId !== mainAgentId) {
                await next.detach().catch(() => next.close());
                return;
            }
            await openExtensionAgent(
                saved.owner,
                next,
                "sidebar",
                false,
                saved.mention,
                "durable",
                undefined,
                saved.statusLabel,
            );
        } catch (error) {
            forgetPersistedAgentPane();
            if (shuttingDown || client.agentId !== mainAgentId) return;
            state = appendTuiError(
                state,
                `Could not restore paired pane: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            renderState();
        }
    }

    /**
     * `interceptedText` carries the text an extension asked to send instead of
     * what the user typed. Its presence is also what stops a second trip
     * through the interceptors.
     */
    function submitPrompt(
        interceptedText?: string,
        injectedPrefix?: number,
    ): void {
        if (
            promptSubmitting
            || sessionSwitchPending
            || pendingSessionRename
            || extensionCommandPending
            || sidebarPromptSubmitting
            || messageInterceptPending
        ) {
            return;
        }
        const typed = interceptedText ?? composer.expandedText().trim();
        // A slash command is addressed to the client, so a quote waiting to be
        // sent stays waiting rather than being folded into an argument.
        const quoted = interceptedText === undefined && !typed.startsWith("/")
            ? pendingQuote
            : undefined;
        const prompt = withQuote(typed, quoted);
        if (prompt.length === 0 && pendingImages.length === 0) {
            return;
        }
        if (
            interceptedText === undefined
            && !prompt.startsWith("/")
            && sidebarAgentPane !== undefined
            && routeVisibleAgentPrompt(prompt)
        ) {
            return;
        }
        // Typing is the signal the tip has been read or ignored. The next one
        // is picked in the gap after this turn, not now.
        composerTip = undefined;
        if (quoted !== undefined) {
            pendingQuote = undefined;
        }
        // Slash commands belong to the client's own registry, so they never
        // reach an interceptor. Everything else is offered once.
        if (
            interceptedText === undefined
            && prompt.length > 0
            && !prompt.startsWith("/")
            && clientExtensionRegistry?.hasMessageInterceptors() === true
        ) {
            offerMessageToExtensions(prompt);
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
        if (
            commandAction !== undefined
            && sidebar.isFocused()
            && sidebarAgentPane !== undefined
            && tuiCommandScope(commandAction) === "main_session"
        ) {
            composer.clearComposer();
            showStatusNotice(
                "Switch to Vera with Ctrl+G to manage its conversation",
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
            const agentId = client.agentId;
            const resolvingSessionPath = agentId !== undefined
                && dependencies.listAgents !== undefined;
            diagnosticsDialog = {
                text: renderTuiDiagnostics({
                    state,
                    activity,
                    elapsed: elapsedWorkingTime(),
                    workspace: client.workspace ?? process.cwd(),
                    runningBackgroundAgents,
                    stash: summarizeStash(),
                    stashRoot: defaultStashRoot(),
                    build: dependencies.build,
                    extensions: configuredClientExtensions,
                }),
                copyReady: !resolvingSessionPath,
            };
            renderState();
            focusActiveSurface();
            if (agentId !== undefined && dependencies.listAgents !== undefined) {
                void dependencies.listAgents().then((agents) => {
                    const sessionPath = agents.find((agent) =>
                        agent.id === agentId
                    )?.session_path;
                    if (
                        diagnosticsDialog === undefined
                        || client.agentId !== agentId
                    ) return;
                    if (sessionPath === undefined) {
                        diagnosticsDialog = {
                            ...diagnosticsDialog,
                            copyReady: true,
                        };
                        renderState();
                        return;
                    }
                    diagnosticsDialog = {
                        text: renderTuiDiagnostics({
                            state,
                            activity,
                            elapsed: elapsedWorkingTime(),
                            sessionPath,
                            workspace: client.workspace ?? process.cwd(),
                            runningBackgroundAgents,
                            stash: summarizeStash(),
                            stashRoot: defaultStashRoot(),
                            build: dependencies.build,
                            extensions: configuredClientExtensions,
                        }),
                        copyReady: true,
                    };
                    renderState();
                }).catch(() => {
                    if (
                        diagnosticsDialog === undefined
                        || client.agentId !== agentId
                    ) return;
                    diagnosticsDialog = {
                        ...diagnosticsDialog,
                        copyReady: true,
                    };
                    renderState();
                });
            }
            return;
        }
        if (commandAction?.type === "show_pool") {
            composer.rememberSubmittedText(prompt);
            composer.clearComposer();
            renderCommandSuggestions();
            state = appendTuiNotice(
                state,
                tuiPoolListing(state.modelSettings?.pooled),
            );
            renderState();
            return;
        }
        if (commandAction?.type === "pool_current_model") {
            composer.rememberSubmittedText(prompt);
            composer.clearComposer();
            renderCommandSuggestions();
            const provider = state.modelSettings?.provider;
            const model = state.modelSettings?.model;
            if (provider === undefined || model === undefined) {
                state = appendTuiError(
                    state,
                    "No model is running yet, so there is nothing to pool",
                );
                renderState();
                return;
            }
            // The same request the picker's pool key sends, so the write, the
            // refusal wording and the transcript notice are one path.
            requestPoolAdmission(provider, model);
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
                state = appendTuiError(
                    state,
                    `${commandAction.source}: command unavailable`,
                );
                renderState();
                return;
            }
            extensionCommandPending = true;
            extensionCommandActivity = `running /${commandAction.command}`;
            renderStatus();
            const extensionSubmittedImages = [...pendingImages];
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
                    undefined,
                    extensionSubmittedImages.length,
                    extensionSubmittedImages.flatMap((image) =>
                        image.path === undefined ? [] : [image.path]
                    ),
                )
                : invokeDirectClientExtensionCommand(
                    directExtension!,
                    commandAction.command,
                    commandAction.argumentsText,
                    { timeoutMs: DIRECT_EXTENSION_COMMAND_TIMEOUT_MS },
                );
            void invocation.then((result) => {
                if (
                    commandAction.origin === "client"
                    && extensionSubmittedImages.length > 0
                ) {
                    const submitted = new Set(
                        extensionSubmittedImages.map((image) => image.requestId),
                    );
                    pendingImages = pendingImages.filter(
                        (image) => !submitted.has(image.requestId),
                    );
                }
                if (shuttingDown || result === undefined) {
                    return;
                }
                if (result.body.kind === "client_action") {
                    if (result.body.action === "show_help") {
                        help = startTuiHelp(
                            coreHelpCommands(),
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
            // A typed model runs as typed. The pool is a shortlist, not a
            // gate, so nothing is added here; `provider/model` names a
            // provider, a bare name keeps the running one.
            const typed = commandAction.model.trim();
            // A pool name is that entry's identity, so it names the provider
            // too; anything else is read as the user typed it.
            const named = state.modelSettings?.pooled?.find(
                (entry) => entry.poolName === typed,
            );
            if (named !== undefined) {
                requestModelSettingsChange(
                    { provider: named.provider, model: named.model },
                    `model → ${typed}`,
                    `the model to ${typed}`,
                );
                renderState();
                return;
            }
            const separator = typed.indexOf("/");
            const provider = separator > 0 ? typed.slice(0, separator) : undefined;
            const model = separator > 0 ? typed.slice(separator + 1) : typed;
            if (model.length === 0) {
                state = appendTuiError(state, `"${typed}" is not a model name`);
                renderState();
                return;
            }
            requestModelSettingsChange(
                {
                    model,
                    ...(provider === undefined ? {} : { provider }),
                },
                `model → ${typed}`,
                `the model to ${typed}`,
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
                confirmingFullAccessAgent = focusedAgentClient();
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
        if (commandAction?.type === "open_configure") {
            composer.clearComposer();
            renderCommandSuggestions();
            void openConfigureEditor();
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
                state = appendTuiError(state, "Session listing is unavailable");
                renderState();
                return;
            }
            const version = ++resumeListVersion;
            const targetAgentId = focusedAgentClient().agentId;
            settingsPicker = startTuiSessionPicker(
                [],
                targetAgentId,
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
                settingsPicker = startTuiSessionPicker(
                    agents,
                    targetAgentId,
                    false,
                    new Date(),
                    true,
                    sharedSessionGroups,
                );
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
                    state = appendTuiError(
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
                state = appendTuiError(state, "Session listing is unavailable");
                renderState();
                return;
            }
            const version = ++resumeListVersion;
            const targetAgentId = focusedAgentClient().agentId;
            settingsPicker = startTuiSessionPicker(
                [],
                targetAgentId,
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
                const currentId = targetAgentId;
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
                settingsPicker = startTuiSessionPicker(
                    children,
                    currentId,
                    false,
                    new Date(),
                    true,
                );
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
                    state = appendTuiError(
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
                state = appendTuiError(state, "Session listing is unavailable");
                renderState();
                return;
            }
            const targetAgentId = focusedAgentClient().agentId;
            void dependencies.listAgents().then((agents) => {
                if (shuttingDown) {
                    return;
                }
                const current = agents.find(
                    (agent) => agent.id === targetAgentId,
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
                state = appendTuiError(
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
                state = appendTuiError(
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
            void withSessionSwitchDeadline(
                dependencies.reconnectSession(currentAgentId),
                discardSwitchTarget,
            ).then((next) => {
                if (shuttingDown) {
                    discardSwitchTarget(next);
                    return;
                }
                switchToClient(next);
            }).catch((error) => {
                if (shuttingDown) return;
                sessionSwitchPending = false;
                state = appendTuiError(
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
            const clearingSidebar = sidebar.isFocused()
                && sidebarAgentPane !== undefined;
            if (
                clearingSidebar
                    ? dependencies.createAgent === undefined
                    : dependencies.createSession === undefined
            ) {
                state = appendTuiError(
                    state,
                    "Starting a new session is unavailable",
                );
                renderState();
                return;
            }
            if (sessionSwitchPending) {
                return;
            }
            const workspace = focusedAgentClient().workspace;
            if (workspace === undefined) {
                state = appendTuiError(
                    state,
                    "Current session workspace is unavailable",
                );
                renderState();
                return;
            }
            sessionSwitchPending = true;
            sessionSwitchActivity = "starting new session…";
            renderStatus();
            const nextSession = clearingSidebar
                ? dependencies.createAgent!(
                    workspace,
                    sidebarInitialApprovalMode
                        ?? focusedAgentState().approvalMode,
                    sidebarAttachmentLifetime,
                )
                : dependencies.createSession!(workspace);
            void withSessionSwitchDeadline(
                nextSession,
                discardSwitchTarget,
            ).then(async (next) => {
                if (shuttingDown) {
                    discardSwitchTarget(next);
                    return;
                }
                if (clearingSidebar) {
                    await openExtensionAgent(
                        sidebarOwner ?? "vera.tui.agent-attachments",
                        requireIdentifiedClient(next),
                        "sidebar",
                        true,
                        sidebarAgentMention,
                        sidebarAttachmentLifetime,
                        sidebarInitialApprovalMode,
                    );
                    sessionSwitchPending = false;
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
                state = appendTuiError(
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
                state = appendTuiError(
                    state,
                    "Cloning this session is unavailable",
                );
                renderState();
                return;
            }
            const sourceAgentId = client.agentId;
            if (sourceAgentId === undefined) {
                state = appendTuiError(
                    state,
                    "Current session ID is unavailable",
                );
                renderState();
                return;
            }
            sessionSwitchPending = true;
            sessionSwitchActivity = "cloning session…";
            renderStatus();
            void withSessionSwitchDeadline(
                dependencies.cloneSession(sourceAgentId),
                discardSwitchTarget,
            ).then((next) => {
                if (shuttingDown) {
                    discardSwitchTarget(next);
                    return;
                }
                switchToClient(next);
            }).catch((error) => {
                if (shuttingDown) return;
                sessionSwitchPending = false;
                const message = error instanceof Error
                    ? error.message
                    : String(error);
                state = appendTuiError(
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
            : beginTuiTurn(state, prompt, attachments, injectedPrefix);
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

    function routeVisibleAgentPrompt(prompt: string): boolean {
        const side = sidebarAgentPane;
        if (side === undefined || client.agentId === undefined) return false;
        const route = routeTuiAgentMessage(
            prompt,
            sidebar.isFocused() ? "sidebar" : "main",
            [
                { agentId: client.agentId, pane: "main", mention: "vera" },
                {
                    agentId: side.agentId,
                    pane: "sidebar",
                    mention: sidebarAgentMention ?? side.agentId,
                },
            ],
        );
        if (route.kind === "unknown") {
            state = appendTuiNotice(state, `No open agent named @${route.mention}`);
            renderState();
            return true;
        }
        if (route.kind === "focus") {
            sidebar.setFocused(route.pane === "sidebar");
            composer.rememberSubmittedText(prompt);
            composer.clearComposer();
            renderCommandSuggestions();
            renderState();
            return true;
        }
        const sendsToSidebar = route.targets.some(
            (target) => target.pane === "sidebar",
        );
        const sendsToMain = route.targets.some((target) => target.pane === "main");
        if (sendsToSidebar) {
            const submittedImages = [...pendingImages];
            const imagePaths = pendingImages.flatMap((image) =>
                image.path === undefined ? [] : [image.path]
            );
            if (imagePaths.length !== pendingImages.length) {
                state = appendTuiNotice(
                    state,
                    "Every sidebar image needs a readable source path",
                );
                renderState();
                return true;
            }
            const controller = new AbortController();
            sidebarPromptSubmitting = true;
            void attachImagesToSidebar(side, imagePaths, controller.signal)
                .then(async (attachments) => {
                    await side.client.send({
                        type: "prompt",
                        content: route.text,
                        ...(attachments.length === 0
                            ? {}
                            : {
                                attachmentIds: attachments.map(
                                    (attachment) => attachment.id,
                                ),
                            }),
                    });
                    if (
                        !userEntryShows(
                            side.state.state.entries.at(-1),
                            route.text,
                            attachments,
                        )
                    ) {
                        side.state.state = side.state.state.working
                            ? queueTuiPrompt(side.state.state, route.text)
                            : beginTuiTurn(
                                side.state.state,
                                route.text,
                                attachments,
                            );
                    } else if (!side.state.state.working) {
                        side.state.state = {
                            ...side.state.state,
                            working: true,
                        };
                    }
                    side.state.workingSince ??= Date.now();
                    side.state.phaseSince ??= side.state.workingSince;
                    side.state.activity = "thinking";
                    if (sendsToMain) {
                        sidebarPromptSubmitting = false;
                        submitPrompt(route.text);
                        return;
                    }
                    if (composer.expandedText().trim() === prompt) {
                        composer.rememberSubmittedText(prompt);
                        composer.clearComposer();
                    }
                    const sent = new Set(
                        submittedImages.map((image) => image.requestId),
                    );
                    pendingImages = pendingImages.filter(
                        (image) => !sent.has(image.requestId),
                    );
                })
                .catch((error) => {
                    side.state.state = {
                        ...side.state.state,
                        working: false,
                    };
                    side.state.workingSince = undefined;
                    side.state.phaseSince = undefined;
                    state = appendTuiNotice(
                        state,
                        error instanceof Error ? error.message : String(error),
                    );
                    renderState();
                }).finally(() => {
                    sidebarPromptSubmitting = false;
                    renderState();
                });
            return true;
        }
        if (sendsToMain && route.text === prompt) return false;
        if (sendsToMain) {
            submitPrompt(route.text);
            return true;
        }
        composer.rememberSubmittedText(prompt);
        composer.clearComposer();
        pendingImages = [];
        renderCommandSuggestions();
        renderState();
        return true;
    }

    async function attachImagesToSidebar(
        side: TuiAgentPane<IdentifiedTuiAgentClient>,
        imagePaths: readonly string[],
        signal: AbortSignal,
    ): Promise<readonly AttachmentRef[]> {
        return Promise.all(imagePaths.map((path) =>
            side.attachImage(randomUUID(), path, signal)
        ));
    }

    /**
     * A handled message still enters submit history and clears the composer:
     * the user submitted it, and an extension acting on it is not a reason to
     * lose the text or leave it sitting in the box.
     */
    function offerMessageToExtensions(prompt: string): void {
        messageInterceptPending = true;
        renderStatus();
        void clientExtensionRegistry!.interceptMessage({
            text: prompt,
            workspace: client.workspace ?? process.cwd(),
            imageCount: pendingImages.length,
        }).then((decision) => {
            messageInterceptPending = false;
            if (shuttingDown) return;
            if (decision.kind === "handled") {
                if (composer.expandedText().trim() === prompt) {
                    composer.rememberSubmittedText(prompt);
                    composer.clearComposer();
                }
                renderState();
                return;
            }
            submitPrompt(
                decision.kind === "replace" ? decision.text : prompt,
                decision.kind === "replace" ? decision.injectedPrefix : undefined,
            );
        }).catch((error) => {
            messageInterceptPending = false;
            if (shuttingDown) return;
            state = appendTuiNotice(
                state,
                error instanceof Error ? error.message : String(error),
            );
            renderState();
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
        pendingImages.push({ requestId, path });
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
                            ...pendingImages[imageIndex],
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
                        state = appendTuiError(
                            state,
                            `Could not attach image: ${update.error}`,
                        );
                        renderState();
                    }
                    composer.focus();
                    continue;
                }
                if (
                    update.type === "consult_result"
                    || update.type === "consult_rejected"
                ) {
                    const pending = pendingConsults.get(update.requestId);
                    if (pending === undefined) continue;
                    if (update.type === "consult_result") {
                        pending.resolve({
                            text: update.text,
                            model: update.model,
                            ...(update.provider === undefined
                                ? {}
                                : { provider: update.provider }),
                        });
                    } else {
                        pending.reject(new Error(update.reason));
                    }
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
                        state = appendTuiError(
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
                        if (pendingUiRequest === undefined) {
                            followTranscriptAfterUiRequest = transcript.scrollTop
                                >= transcript.scrollHeight
                                    - transcript.viewport.height;
                        }
                        // Requests must reveal the pane that owns them. A
                        // hidden question otherwise disables composer UI while
                        // looking like neither agent needs an answer.
                        sidebar.setFocused(false);
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
                        if (
                            update.type === "ui_request_closed"
                            && pendingUiRequest === undefined
                            && followTranscriptAfterUiRequest
                        ) {
                            transcript.scrollTo(transcript.scrollHeight);
                            followTranscriptAfterUiRequest = false;
                            renderJumpToBottom();
                        }
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
                    const poolChange = pendingPoolChanges.get(update.requestId);
                    pendingPoolChanges.delete(update.requestId);
                    if (
                        poolChange !== undefined
                        && update.type === "model_settings"
                    ) {
                        poolChangeUndo = poolChange;
                    }
                    const pendingUndo = pendingPoolUndos.get(update.requestId);
                    pendingPoolUndos.delete(update.requestId);
                    if (
                        pendingUndo?.completesOnSettings === true
                        && update.type === "model_settings"
                    ) {
                        poolChangeUndo = undefined;
                        showStatusNotice("pool change undone");
                    } else if (
                        pendingUndo !== undefined
                        && update.type === "model_settings_rejected"
                    ) {
                        poolChangeUndo = pendingUndo.undo;
                        if (settingsPicker?.kind === "model") {
                            settingsPicker = {
                                ...settingsPicker,
                                canUndoPoolChange: true,
                            };
                        }
                        state = appendTuiError(
                            state,
                            rejectionNotice("undo that pool change", update.reason),
                        );
                    }
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
                        state = appendTuiError(
                            state,
                            rejectionNotice(subject, update.reason),
                        );
                    }
                }
                observeActivity(update);
                if (
                    update.type === "pool_admission_result"
                    && retryPoolAdmission(update.requestId, update.verdict)
                ) {
                    renderState();
                    continue;
                }
                state = applyAgentUpdate(state, update);
                if (update.type === "pool_admission_result") {
                    const pendingUndo = pendingPoolUndos.get(update.requestId);
                    if (
                        pendingUndo !== undefined
                        && update.verdict === "added"
                        && pendingUndo.undo.poolName !== undefined
                    ) {
                        pendingPoolUndos.delete(update.requestId);
                        const nameRequestId = randomUUID();
                        pendingPoolUndos.set(nameRequestId, {
                            undo: pendingUndo.undo,
                            completesOnSettings: true,
                        });
                        sendCommand({
                            type: "pool_name",
                            requestId: nameRequestId,
                            provider: update.provider,
                            model: update.model,
                            name: pendingUndo.undo.poolName,
                        });
                    } else if (
                        pendingUndo !== undefined
                        && update.verdict !== "added"
                    ) {
                        pendingPoolUndos.delete(update.requestId);
                        poolChangeUndo = pendingUndo.undo;
                        if (settingsPicker?.kind === "model") {
                            settingsPicker = {
                                ...settingsPicker,
                                canUndoPoolChange: true,
                            };
                        }
                    }
                }
                if (
                    update.type === "pool_admission_result"
                    && pendingPoolName?.requestId === update.requestId
                ) {
                    const pending = pendingPoolName;
                    pendingPoolName = undefined;
                    if (update.verdict === "added" && namePrompt === undefined) {
                        namePrompt = startTuiNamePrompt(
                            {
                                kind: "pool",
                                provider: pending.provider,
                                model: pending.model,
                            },
                            pending.label,
                            settingsPicker?.kind === "model"
                                ? settingsPicker
                                : undefined,
                        );
                        focusActiveSurface();
                    }
                }
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
                    if (poolChangeUndo !== undefined) {
                        settingsPicker = {
                            ...settingsPicker,
                            canUndoPoolChange: true,
                        };
                    }
                }
                if (
                    update.type === "model_settings"
                    && settingsPicker?.kind === "reviewer_settings"
                ) {
                    // Same rule: the rows read the host's snapshot, not a
                    // local guess about what the choice did.
                    settingsPicker = withTuiPickerParent(
                        startTuiReviewerMenu(state.modelSettings?.reviewerDefault),
                        settingsPicker.parent,
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
                        state = appendTuiError(
                            state,
                            rejectionNotice(subject, update.reason),
                        );
                    } else if (preferencesList !== undefined) {
                        state = appendTuiError(
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
                // State is applied per update above; the repaint is what
                // coalesces, so a burst of deltas paints once a frame.
                renderCoalescer.request(update.type);

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
            // An extension edit is a settings edit like any other: it says what
            // it asked for while it is in flight, and a refusal names the same
            // thing rather than leaving the user to guess what was tried.
            const subject = modelPatchSubject(patch);
            requestedModelChanges.set(requestId, subject);
            showStatusNotice(`model → ${describeModelPatch(patch)}`);
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

    function requireSidebarOwner(extensionId: string): void {
        if (sidebarOwner !== extensionId) {
            throw new Error("The sidebar is not open for this extension");
        }
    }

    /**
     * The user's own name for a pooled model, swapped for the id the provider
     * knows. An extension is handed whatever was typed, and a pool name is the
     * client's data to resolve.
     */
    function resolvePooledModel(
        request: VeraClientConsultRequest,
    ): VeraClientConsultRequest {
        const wanted = request.model.toLowerCase();
        for (const entry of state.modelSettings?.pooled ?? []) {
            if (entry.poolName?.toLowerCase() !== wanted) continue;
            return {
                ...request,
                model: entry.model,
                ...(request.provider === undefined
                    ? { provider: entry.provider }
                    : {}),
            };
        }
        return request;
    }

    function requestExtensionConsult(
        consultRequest: VeraClientConsultRequest,
        signal: AbortSignal,
    ): Promise<VeraClientConsultResult> {
        const request = resolvePooledModel(consultRequest);
        if (signal.aborted) {
            return Promise.reject(signal.reason as Error);
        }
        const requestId = randomUUID();
        return new Promise<VeraClientConsultResult>((resolve, reject) => {
            const settle = (): void => {
                signal.removeEventListener("abort", onAbort);
                pendingConsults.delete(requestId);
            };
            const onAbort = (): void => {
                settle();
                reject(signal.reason as Error);
            };
            signal.addEventListener("abort", onAbort, { once: true });
            pendingConsults.set(requestId, {
                resolve: (result) => {
                    settle();
                    resolve(result);
                },
                reject: (reason) => {
                    settle();
                    reject(reason);
                },
            });
            sendCommand({
                type: "consult",
                requestId,
                model: request.model,
                ...(request.provider === undefined
                    ? {}
                    : { provider: request.provider }),
                ...(request.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: request.reasoningEffort }),
                ...(request.systemPrompt === undefined
                    ? {}
                    : { systemPrompt: request.systemPrompt }),
                messages: request.messages.map((message) => ({
                    role: message.role,
                    content: message.content,
                })),
                ...(request.maxTokens === undefined
                    ? {}
                    : { maxTokens: request.maxTokens }),
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
                    coreHelpCommands(),
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
            state = appendTuiError(
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
        const uiRequest = focusedUiRequest();
        if (
            uiRequest !== undefined
            && isToolApprovalUiRequestUpdate(uiRequest)
        ) {
            return () => approvalView.focus();
        }
        if (
            uiRequest !== undefined
            && isUserQuestionUiRequestUpdate(uiRequest)
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
        if (diagnosticsDialog !== undefined) {
            return () => diagnosticsDialogView.focus();
        }
        if (confirmingFullAccess) {
            return () => permissionsConfirmView.box.focus();
        }
        if (admissionDialog !== undefined) {
            return () => admissionDialogView.box.focus();
        }
        if (sessionTrashCandidate !== undefined) {
            return () => sessionTrashConfirmView.box.focus();
        }
        if (namePrompt !== undefined) {
            return () => namePromptView.box.focus();
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

    /**
     * Give every session switch a deadline.
     *
     * A pending switch swallows the palette and refuses new prompts, so a host
     * request that never settles would strand the client with no way back. On
     * timeout the caller's rejection path runs, the old session stays attached,
     * and a late answer is discarded rather than swapped in behind the user.
     */
    function withSessionSwitchDeadline<T>(
        request: Promise<T>,
        discardLate: (value: T) => void,
    ): Promise<T> {
        let timedOut = false;
        let timeout: ReturnType<typeof setTimeout>;
        const deadline = new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
                timedOut = true;
                reject(new Error("timed out"));
            }, dependencies.sessionSwitchTimeoutMs ?? SESSION_SWITCH_TIMEOUT_MS);
            // The deadline only matters to a TUI that is still on screen.
            // Left referenced, quitting mid-switch would hold the process open
            // until it fired.
            timeout.unref?.();
        });
        void request.then((value) => {
            if (timedOut) {
                discardLate(value);
            }
        }, () => undefined);
        return Promise.race([request, deadline]).finally(() => {
            clearTimeout(timeout);
        });
    }

    /** Drop a session the client asked for but can no longer use. */
    function discardSwitchTarget(next: TuiAgentClient): void {
        void next.detach().catch(() => next.close());
    }

    function beginFork(boundaryId: string): void {
        timelinePicker = undefined;
        timelinePickerView.box.visible = false;
        if (dependencies.forkSession === undefined) {
            state = appendTuiError(state, "Forking this session is unavailable");
            composer.focus();
            renderState();
            return;
        }
        const sourceAgentId = client.agentId;
        if (sourceAgentId === undefined) {
            state = appendTuiError(state, "Current session ID is unavailable");
            composer.focus();
            renderState();
            return;
        }
        sessionSwitchPending = true;
        sessionSwitchActivity = "forking session…";
        renderState();
        void withSessionSwitchDeadline(
            dependencies.forkSession(sourceAgentId, boundaryId),
            (result) => discardSwitchTarget(result.client),
        ).then((result) => {
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
            if (shuttingDown) return;
            sessionSwitchPending = false;
            const message = error instanceof Error ? error.message : String(error);
            state = appendTuiError(
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
        namePrompt = undefined;
        commandPalette = undefined;
        help = undefined;
        confirmingFullAccess = false;
        admissionDialog = undefined;
        admissionReturnPicker = undefined;
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

    /**
     * What the pool looks like right now, which is what every relevance
     * predicate is written against. Read fresh each time rather than cached:
     * pooling a model is exactly the kind of thing that should retire the tip
     * telling you to pool one.
     */
    function tipContext(inModelPicker: boolean): TuiTipContext {
        const pooled = state.modelSettings?.pooled ?? [];
        return {
            launches: tipState.launches,
            pooledCount: pooled.length,
            namedPoolCount: pooled.filter((entry) =>
                entry.poolName !== undefined
            ).length,
            anyVerified: pooled.some((entry) => entry.verified),
            inModelPicker,
        };
    }

    /**
     * The built-in tips plus whatever extensions registered, read fresh so a
     * later-loading extension's tips join the pool without a restart.
     */
    function tipPool(): readonly TuiTip[] {
        const registered = clientExtensionRegistry?.tips() ?? [];
        if (registered.length === 0) return TUI_TIPS;
        return [
            ...TUI_TIPS,
            ...registered.map((descriptor) => ({
                id: descriptor.id,
                text: () => descriptor.text,
                cooldownLaunches: descriptor.cooldownLaunches,
                isRelevant: (context: TuiTipContext) =>
                    descriptor.isRelevant(context),
            })),
        ];
    }

    /**
     * A tip to show, recorded as shown. Returns nothing when tips are off,
     * when nothing is eligible, or when the pool is exhausted for this launch.
     */
    function takeTip(inModelPicker: boolean): string | undefined {
        if (!tipsEnabled) return undefined;
        const tip = selectTuiTip(
            tipContext(inModelPicker),
            tipState.history,
            tipPool(),
        );
        if (tip === undefined) return undefined;
        tipState = {
            launches: tipState.launches,
            history: recordTuiTipShown(
                tip.id,
                tipState.history,
                tipState.launches,
            ),
        };
        saveTuiTipState(tipState);
        return tip.text(tipContext(inModelPicker));
    }

    function renderState(): void {
        if (shuttingDown) {
            return;
        }
        const uiRequest = focusedUiRequest();

        placeholder.visible = state.entries.length === 0;
        // The transcript tip appears in the gap after a turn, which is the one
        // moment the user is reading rather than typing, and it is gone by the
        // time the next turn starts. Armed by the turn ending rather than by
        // the idle state itself, so the line does not come straight back in
        // the frames between a submit and the turn actually starting.
        if (tipsEnabled && workingLastRender && !state.working) {
            composerTip = takeTip(false);
        }
        workingLastRender = state.working;
        composerTipText.content = composerTip === undefined
            ? new StyledText([])
            // Text nodes lay their content out from column zero, so the
            // indent the transcript rows share is written in rather than set
            // as padding.
            : new StyledText([
                fg(TUI_ACCENT)("  Tip "),
                fg(TUI_MUTED)(composerTip),
            ]);
        composerTipText.visible = composerTip !== undefined
            && !anyOverlayOpen();
        renderHeldAddress();
        composer.placeholder = extensionAddressee === undefined
            ? sidebar.isFocused() && sidebarAgentMention !== undefined
                ? `Message ${sidebarAgentMention}\u2026`
                : COMPOSER_PLACEHOLDER
            : `Message ${extensionAddressee}\u2026`;
        renderPendingQuote();
        const focusedState = focusedAgentState();
        const queuedPrompt = renderTuiQueuedPrompt(focusedState);
        queuedPromptText.content = queuedPrompt.length === 0
            ? ""
            : `  ${queuedPrompt}`;
        queuedPromptText.visible = focusedState.queuedPrompts.length > 0;
        approvalView.box.visible = uiRequest?.request.type
            === "tool_approval";
        questionView.box.visible = uiRequest?.request.type
            === "user_question";
        // A model, directory, and approval mode do not explain either pending
        // request. Both cards replace the composer and status band until the
        // user answers, so no status text can paint across their final row.
        statusText.visible = !(approvalView.box.visible
            || questionView.box.visible);
        statusBand.visible = !(approvalView.box.visible
            || questionView.box.visible);
        timelinePickerView.box.visible = uiRequest === undefined
            && timelinePicker !== undefined;
        // Over the connect pane it was opened from, so the pane is still there
        // to go back to when the key is saved or the prompt is abandoned.
        namePromptView.box.visible = uiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && namePrompt !== undefined;
        secretPromptView.box.visible = uiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && namePrompt === undefined
            && secretPrompt !== undefined;
        settingsPickerView.box.visible = uiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && secretPrompt === undefined
            && namePrompt === undefined
            && settingsPicker !== undefined;
        preferencesListView.box.visible = uiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && settingsPicker === undefined
            && preferencesList !== undefined;
        commandPaletteView.box.visible = uiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && settingsPicker === undefined
            && secretPrompt === undefined
            && preferencesList === undefined
            && commandPalette !== undefined;
        helpView.box.visible = uiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && settingsPicker === undefined
            && commandPalette === undefined
            && help !== undefined;
        diagnosticsDialogView.box.visible = uiRequest === undefined
            && timelinePicker === undefined
            && !confirmingFullAccess
            && sessionTrashCandidate === undefined
            && settingsPicker === undefined
            && commandPalette === undefined
            && help === undefined
            && diagnosticsDialog !== undefined;
        permissionsConfirmView.box.visible = uiRequest === undefined
            && timelinePicker === undefined
            && sessionTrashCandidate === undefined
            && confirmingFullAccess;
        admissionDialogView.box.visible = uiRequest === undefined
            && timelinePicker === undefined
            && sessionTrashCandidate === undefined
            && !confirmingFullAccess
            && admissionDialog !== undefined;
        sessionTrashConfirmView.box.visible = uiRequest === undefined
            && timelinePicker === undefined
            && sessionTrashCandidate !== undefined;
        const overlayVisible = approvalView.box.visible
            || questionView.box.visible
            || timelinePickerView.box.visible
            || settingsPickerView.box.visible
            || preferencesListView.box.visible
            || commandPaletteView.box.visible
            || helpView.box.visible
            || diagnosticsDialogView.box.visible
            || permissionsConfirmView.box.visible
            || admissionDialogView.box.visible
            || sessionTrashConfirmView.box.visible
            || namePromptView.box.visible
            || secretPromptView.box.visible;
        overlayScrim.visible = overlayVisible;
        // OpenTUI's translucent fill darkens cell backgrounds but leaves the
        // glyphs beneath it untouched. Fade the background renderables too so
        // transcript, composer, and status remain context rather than becoming
        // the highest-contrast text on screen.
        const backgroundOpacity = overlayVisible
            ? DIALOG_BACKGROUND_OPACITY
            : 1;
        sidebar.body.opacity = backgroundOpacity;
        jumpToBottom.opacity = backgroundOpacity;
        sidebarJump.opacity = backgroundOpacity;
        composerTipText.opacity = backgroundOpacity;
        quoteText.opacity = backgroundOpacity;
        heldAddressText.opacity = backgroundOpacity;
        composerBox.opacity = backgroundOpacity;
        statusBand.opacity = backgroundOpacity;
        // Ordinary modals leave the conversation and composer in place as
        // dimmed context. The scrim sits above them and below the active card.
        // Approval and question cards are different: they replace the composer
        // until the pending engine request is answered.
        composerBox.visible = uiRequest === undefined;
        renderCommandSuggestions();
        if (
            uiRequest !== undefined
            && isToolApprovalUiRequestUpdate(uiRequest)
        ) {
            approvalView.update(uiRequest);
        }
        if (
            uiRequest !== undefined
            && isUserQuestionUiRequestUpdate(uiRequest)
        ) {
            questionView.update(uiRequest);
        }
        if (timelinePicker !== undefined) {
            timelinePickerView.update(timelinePicker);
        }
        if (settingsPicker === undefined) {
            pickerTipKind = undefined;
            settingsPickerView.tip = undefined;
        } else if (tipsEnabled && pickerTipKind !== settingsPicker.kind) {
            // One tip per pane, chosen when the pane opens. Rechoosing on
            // every keystroke would make the line flicker under the search
            // query, and the pane is one place, not one place per row.
            pickerTipKind = settingsPicker.kind;
            settingsPickerView.tip = takeTip(settingsPicker.kind === "model");
        }
        if (settingsPicker !== undefined) {
            settingsPickerView.update(settingsPicker);
        }
        if (secretPrompt !== undefined) {
            secretPromptView.update(secretPrompt);
        }
        if (namePrompt !== undefined) {
            namePromptView.update(namePrompt);
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
        if (diagnosticsDialog !== undefined) {
            diagnosticsDialogView.update(diagnosticsDialog);
        }
        if (sessionTrashCandidate !== undefined) {
            sessionTrashConfirmView.update(sessionTrashCandidate.label);
        }
        if (admissionDialog !== undefined) {
            admissionDialogView.update(admissionDialog, dialogAdmission());
        }

        // Transcript state can replace a live row with a different semantic
        // row at the same index (most notably `thinking` -> `thought`). Reusing
        // the old renderable leaves OpenTUI's wrapped-text geometry stale in
        // longer transcripts, producing reasoning bodies only a few columns
        // wide. Rebuild from the first changed kind so ordering stays intact
        // without redrawing the stable prefix.
        const changedKindAt = state.entries.findIndex((entry, index) =>
            entryNodes[index] !== undefined
            && entryNodeKinds[index] !== entry.kind
        );
        const retainedEntries = changedKindAt === -1
            ? state.entries.length
            : changedKindAt;
        while (entryNodes.length > retainedEntries) {
            entryNodes.pop()?.destroy();
            entryNodeKinds.pop();
        }

        state.entries.forEach((entry, index) => {
            const existing = entryNodes[index];
            if (existing) {
                existing.visible = entry.kind !== "tool"
                    || entry.hidden !== true;
                if (
                    existing instanceof MarkdownRenderable &&
                    existing.content !== tuiMarkdownEntryContent(
                        entry,
                        assistantFollowsWork(state.entries, index),
                        mainTranscriptWidth(),
                    )
                ) {
                    existing.content = tuiMarkdownEntryContent(
                        entry,
                        assistantFollowsWork(state.entries, index),
                        mainTranscriptWidth(),
                    );
                }
                if (entry.kind === "tool" && existing instanceof BoxRenderable) {
                    updateTuiToolRow(existing, entry);
                }
                if (
                    entry.kind === "tool_header"
                    && existing instanceof BoxRenderable
                ) {
                    updateTuiToolHeader(existing, entry);
                }
                if (
                    (entry.kind === "thought"
                        || entry.kind === "thinking"
                        || entry.kind === "notice"
                        || entry.kind === "inbox")
                    && existing instanceof TextRenderable
                ) {
                    // A thought row's height changes when its fold opens, a
                    // thinking row grows with every delta, and an admission
                    // checklist notice is rewritten in place per step, so all
                    // are re-rendered rather than left as first drawn.
                    existing.content = renderTuiEntry(entry);
                }
                return;
            }

            const marginTop = tuiEntryMarginTop(state.entries, index);
            const separatedAssistant = assistantFollowsWork(
                state.entries,
                index,
            );
            const markdownNode = entry.kind === "diff"
                ? undefined
                : createTuiMarkdownEntry(
                    renderer,
                    `entry-${index}`,
                    entry,
                    markdownStyle,
                    TUI_TEXT,
                    marginTop,
                    separatedAssistant,
                    mainTranscriptWidth(),
                );
            const node = entry.kind === "tool"
                ? createTuiToolRow(
                    renderer,
                    `entry-${index}`,
                    entry,
                    marginTop,
                )
                : entry.kind === "tool_header"
                ? createTuiToolHeader(
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
            entryNodeKinds.push(entry.kind);
            node.visible = entry.kind !== "tool" || entry.hidden !== true;
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
        return focusedUiRequest() !== undefined
            || timelinePicker !== undefined
            || secretPrompt !== undefined
            || namePrompt !== undefined
            || settingsPicker !== undefined
            || preferencesList !== undefined
            || commandPalette !== undefined
            || help !== undefined
            || diagnosticsDialog !== undefined
            || confirmingFullAccess
            || admissionDialog !== undefined
            || sessionTrashCandidate !== undefined;
    }

    function clearTranscriptNodes(): void {
        while (entryNodes.length > 0) {
            entryNodes.pop()?.destroy();
            entryNodeKinds.pop();
        }
    }

    // The surface openers below are shared by three callers: a slash command, a
    // palette row, and a /settings menu entry. Keeping them here means the three
    // routes cannot drift into opening the same picker with different arguments.

    function openReviewerMenu(parent?: TuiSettingsPickerState): void {
        settingsPicker = withTuiPickerParent(
            startTuiReviewerMenu(state.modelSettings?.reviewerDefault),
            parent,
        );
        renderState();
        focusActiveSurface();
    }

    function openReviewerPicker(
        slot: TuiReviewerSlot,
        parent?: TuiSettingsPickerState,
    ): void {
        const reviewer = state.modelSettings?.reviewerDefault;
        settingsPicker = withTuiPickerParent(
            startTuiReviewerPicker(
                slot,
                state.modelSettings?.pooled,
                slot === "primary" ? reviewer?.primary : reviewer?.fallback,
                state.modelSettings?.availableModels,
            ),
            parent,
        );
        renderState();
        focusActiveSurface();
    }

    /**
     * The primary is required, so clearing it means the fallback has nothing to
     * sit behind: the whole reviewer is cleared instead. Clearing the failsafe
     * alone keeps the primary and sends `null` for the second slot.
     */
    function reviewerPatchFor(
        selection: { slot: TuiReviewerSlot; provider?: string; model?: string },
    ): ModelSettingsPatch["reviewer"] {
        const chosen = selection.model === undefined ? undefined : {
            model: selection.model,
            ...(selection.provider === undefined
                ? {}
                : { provider: selection.provider }),
        };
        const current = state.modelSettings?.reviewerDefault;
        if (selection.slot === "primary") {
            if (chosen === undefined) return null;
            return {
                primary: chosen,
                ...(current?.fallback === undefined
                    ? {}
                    : { fallback: current.fallback }),
            };
        }
        if (current?.mode !== "fixed" || current.primary === undefined) {
            // A failsafe is the second entry of a route with no first entry.
            return undefined;
        }
        return { primary: current.primary, fallback: chosen ?? null };
    }

    function reviewerToast(
        selection: { slot: TuiReviewerSlot; provider?: string; model?: string },
    ): string {
        const name = selection.model === undefined
            ? "default"
            : selection.model;
        return selection.slot === "primary" ? name : `failsafe ${name}`;
    }

    function openModelPicker(parent?: TuiSettingsPickerState): void {
        if (parent === undefined) settingsPickerAgent = focusedAgentClient();
        const targetState = focusedAgentState();
        settingsPicker = withTuiPickerParent(startTuiSettingsPicker(
            "model",
            targetState.modelSettings?.model,
            targetState.modelSettings?.reasoningEffort,
            targetState.approvalMode,
            targetState.modelSettings?.availableModels,
            undefined,
            targetState.modelSettings?.provider,
            undefined,
            targetState.modelSettings?.pooled,
        ), parent);
        // Auth changes happen outside the host's original model snapshot.
        // Refresh here so reopening the picker also repairs a stale model pane
        // that was kept underneath the provider picker.
        requestAgentSettings(focusedAgentClient());
        renderState();
        focusActiveSurface();
    }

    async function openConfigureEditor(): Promise<void> {
        renderer.suspend();
        try {
            await (dependencies.openConfigure ?? (() =>
                openFileInEditor(veraConfigPath())))();
            state = appendTuiNotice(
                state,
                "Configure editor closed. Restart Vera to apply config changes.",
            );
        } catch (error) {
            state = appendTuiError(
                state,
                `Could not open config: ${error instanceof Error ? error.message : String(error)}`,
            );
        } finally {
            renderer.resume();
            renderState();
            focusActiveSurface();
        }
    }

    /**
     * The level facts for one model, looked up off the wire rather than a
     * flat effort list, so a pane renders exactly what this model offers.
     *
     * A ready pool entry wins over the runnable list: admission narrowed its
     * levels to the ones this key actually verified, and the catalog's full
     * list would offer settings the engine will refuse. A model in neither
     * list (unrecognised, e.g. reached through the `/model <name>` escape
     * hatch) is treated the same as a model with an empty `levels` array: no
     * facts about it have reached the client.
     */
    function modelLevelFacts(
        provider: string | undefined,
        model: string | undefined,
        source: TuiState = focusedAgentState(),
    ): {
        readonly levels: readonly ReasoningLevel[];
        readonly defaultLevel?: ReasoningLevelId;
    } | undefined {
        const pooledEntry = source.modelSettings?.pooled?.find((candidate) =>
            candidate.provider === provider && candidate.model === model
        );
        if (pooledEntry?.available === true) {
            return pooledEntry;
        }
        return source.modelSettings?.availableModels?.find((candidate) =>
            candidate.provider === provider && candidate.model === model
        );
    }

    function currentModelLevels(): readonly ReasoningLevel[] {
        const targetState = focusedAgentState();
        return modelLevelFacts(
            targetState.modelSettings?.provider,
            targetState.modelSettings?.model,
            targetState,
        )?.levels ?? [];
    }

    function openReasoningPicker(parent?: TuiSettingsPickerState): void {
        if (parent === undefined) settingsPickerAgent = focusedAgentClient();
        const targetState = focusedAgentState();
        // An empty (or unresolved) level list means this model has no
        // reasoning control at all. A card with no rows is indistinguishable
        // from the TUI ignoring the key, so say why there is nothing to pick.
        // This is presentation only: the engine still decides what it will
        // accept.
        const levels = currentModelLevels();
        if (levels.length === 0) {
            state = appendTuiNotice(
                state,
                `${
                    targetState.modelSettings === undefined
                        ? "this model"
                        : `${targetState.modelSettings.provider}/${targetState.modelSettings.model}`
                } has no reasoning effort setting`,
            );
            renderState();
            return;
        }
        const current = modelLevelFacts(
            targetState.modelSettings?.provider,
            targetState.modelSettings?.model,
            targetState,
        );
        settingsPicker = withTuiPickerParent(startTuiReasoningPicker(
            levels,
            current?.defaultLevel,
            targetState.modelSettings?.reasoningEffort,
        ), parent);
        renderState();
        focusActiveSurface();
    }

    function openPermissionsPicker(parent?: TuiSettingsPickerState): void {
        if (parent === undefined) settingsPickerAgent = focusedAgentClient();
        const targetState = focusedAgentState();
        if (targetState.permissionInspection !== undefined) {
            const notice = renderPermissionInspection(
                targetState.permissionInspection,
            );
            if (sidebar.isFocused() && sidebarAgentPane !== undefined) {
                sidebarAgentPane.state.state = appendTuiNotice(
                    sidebarAgentPane.state.state,
                    notice,
                );
                renderSidebarAgent(sidebarAgentPane);
            } else {
                state = appendTuiNotice(state, notice);
            }
        }
        settingsPicker = withTuiPickerParent(startTuiSettingsPicker(
            "permissions",
            targetState.modelSettings?.model,
            targetState.modelSettings?.reasoningEffort,
            targetState.approvalMode,
            targetState.modelSettings?.availableModels,
            undefined,
            undefined,
            targetState.permissionInspection?.availableModes,
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
                state = appendTuiError(
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
            state = appendTuiError(
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
        // Everything below this point answers in the transcript, so the pane
        // goes away first. A notice written behind an open card is a notice the
        // user has to dismiss a modal to discover, and the sign-in URL is the
        // one line they cannot afford to miss.
        settingsPicker = undefined;
        closeSettingsPickerSurface();
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
        // Enter can still land twice, from two trips into the pane, and the
        // callback listener binds a fixed port: a second run would fail on the
        // first one's own server.
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
            renderState();
        }, (error: unknown) => {
            connectingProviders.delete(provider.id);
            state = appendTuiError(
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
                requestAgentSettings(focusedAgentClient());
            } catch (error) {
                state = appendTuiError(
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
        if (settingsPicker?.kind === "model") {
            requestAgentSettings(focusedAgentClient());
        }
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
        prompt: TuiNamePromptState,
        transition: TuiNamePromptTransition,
    ): void {
        namePrompt = transition.state;
        if (namePrompt !== undefined) {
            renderState();
            return;
        }
        // A pool name leaves the pane it was opened over alone: the settings
        // snapshot that follows the write rebuilds it, and the captured parent
        // is the list as it read before the name existed.
        const parent = prompt.parent;
        settingsPicker = prompt.target.kind === "pool"
            ? settingsPicker ?? parent
            : parent;
        if (transition.submitted !== undefined && prompt.target.kind === "pool") {
            sendCommand({
                type: "pool_name",
                requestId: randomUUID(),
                provider: prompt.target.provider,
                model: prompt.target.model,
                name: transition.submitted,
            });
        } else if (
            transition.submitted !== undefined
            && prompt.target.kind === "session"
        ) {
            if (prompt.target.sessionId === client.agentId) {
                const requestId = randomUUID();
                pendingSessionRename = { requestId };
                sendCommand({
                    type: "update_session_name",
                    requestId,
                    name: transition.submitted,
                });
            } else {
                void performSessionRename(
                    prompt.target.sessionId,
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
            state = appendTuiError(
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
        state = result.status === "renamed"
            ? appendTuiNotice(
                state,
                result.name === null
                    ? "session name cleared"
                    : `session renamed: ${result.name}`,
            )
            : appendTuiError(
                state,
                result.reason === "busy"
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
            settingsPicker = startTuiSessionPicker(
                agents,
                client.agentId,
                false,
                new Date(),
                true,
                sharedSessionGroups,
            );
            renderState();
        } catch {
            // The pane keeps the rows it has: a failed refresh is not a
            // reason to close what the user is working in.
        }
    }

    function openSettingsMenu(): void {
        settingsPickerAgent = focusedAgentClient();
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
        if (target === "reviewer") return openReviewerMenu(parent);
        if (target === "reviewer_primary") {
            return openReviewerPicker("primary", parent);
        }
        if (target === "reviewer_fallback") {
            return openReviewerPicker("fallback", parent);
        }
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
        const returningToModelPicker = settingsPicker?.kind !== "model"
            && transition.state?.kind === "model";
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
            namePrompt = startTuiNamePrompt(
                {
                    kind: "session",
                    sessionId: transition.renameCandidate.sessionId,
                },
                transition.renameCandidate.label,
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
            // The pane it returns to is the one the transition left behind, not
            // the one the key arrived on: ⇥ onto Providers wraps the list back
            // to its first tab, and Escape has to land on that.
            openProviderPicker(
                settingsPicker?.kind === "model"
                    ? settingsPicker
                    : previousPicker?.kind === "extension"
                    ? undefined
                    : previousPicker,
            );
            return;
        }
        if ("poolVerify" in transition && transition.poolVerify !== undefined) {
            openVerifyDialog(
                transition.poolVerify.provider,
                transition.poolVerify.model,
            );
            return;
        }
        if ("poolName" in transition && transition.poolName !== undefined) {
            namePrompt = startTuiNamePrompt(
                {
                    kind: "pool",
                    provider: transition.poolName.provider,
                    model: transition.poolName.model,
                },
                transition.poolName.label,
                previousPicker?.kind === "extension" ? undefined : previousPicker,
            );
            renderState();
            focusActiveSurface();
            return;
        }
        if ("poolToggle" in transition && transition.poolToggle !== undefined) {
            // The pane stays open and stays on the same row. It is not updated
            // here: the settings snapshot that comes back rebuilds it, so what
            // the user sees is what the host stored rather than a guess.
            const toggle = transition.poolToggle;
            poolChangeUndo = undefined;
            if (settingsPicker?.kind === "model") {
                settingsPicker = {
                    ...settingsPicker,
                    canUndoPoolChange: false,
                };
            }
            if (toggle.action === "add") {
                // The name prompt follows the verdict, not the keypress: a
                // model that never made it into the pool cannot be named.
                const requestId = requestPoolAdmission(
                    toggle.provider,
                    toggle.model,
                );
                pendingPoolName = {
                    requestId,
                    provider: toggle.provider,
                    model: toggle.model,
                    label: `${toggle.provider}/${toggle.model}`,
                };
                pendingPoolChanges.set(requestId, {
                    action: "remove",
                    provider: toggle.provider,
                    model: toggle.model,
                });
                return;
            }
            const removed = state.modelSettings?.pooled?.find((entry) =>
                entry.provider === toggle.provider
                && entry.model === toggle.model
            );
            const requestId = randomUUID();
            pendingPoolChanges.set(requestId, {
                action: "add",
                provider: toggle.provider,
                model: toggle.model,
                ...(removed?.poolName === undefined
                    ? {}
                    : { poolName: removed.poolName }),
            });
            sendCommand({
                type: "pool_remove",
                requestId,
                provider: toggle.provider,
                model: toggle.model,
            });
        }
        if (
            "undoPoolChange" in transition
            && transition.undoPoolChange === true
            && poolChangeUndo !== undefined
        ) {
            const undo = poolChangeUndo;
            if (settingsPicker?.kind === "model") {
                settingsPicker = {
                    ...settingsPicker,
                    canUndoPoolChange: false,
                };
            }
            if (undo.action === "remove") {
                const requestId = randomUUID();
                pendingPoolUndos.set(requestId, {
                    undo,
                    completesOnSettings: true,
                });
                sendCommand({
                    type: "pool_remove",
                    requestId,
                    provider: undo.provider,
                    model: undo.model,
                });
            } else {
                const requestId = requestPoolAdmission(
                    undo.provider,
                    undo.model,
                );
                pendingPoolUndos.set(requestId, {
                    undo,
                    completesOnSettings: undo.poolName === undefined,
                });
            }
            return;
        }
        if (transition.selection !== undefined) {
            const selection = transition.selection;
            if (selection.kind === "extension") {
                return;
            }
            if (selection.kind === "model") {
                // Choosing a model runs it and nothing else. The pool is the
                // user's own shortlist, so it is only ever written by the key
                // that says so.
                const chosenLevels = selection.reasoningEffort === undefined
                    ? modelLevelFacts(selection.provider, selection.model)
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
                    settingsPickerAgent,
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
                    settingsPickerAgent,
                );
            } else if (selection.kind === "permissions") {
                if (selection.mode === "full_access") {
                    confirmingFullAccess = true;
                    confirmingFullAccessAgent = settingsPickerAgent;
                } else {
                    requestPermissionsChange(
                        selection.mode,
                        settingsPickerAgent,
                    );
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
            } else if (selection.kind === "reviewer") {
                const patch = reviewerPatchFor(selection);
                if (patch === undefined) {
                    showStatusNotice("Choose a primary reviewer first");
                } else {
                    requestModelSettingsChange(
                        { reviewer: patch },
                        `reviewer → ${reviewerToast(selection)}`,
                        `the ${selection.slot === "primary"
                            ? "reviewer"
                            : "failsafe reviewer"}`,
                        settingsPickerAgent,
                    );
                }
            } else {
                beginSessionResume(selection.sessionPath, selection.sessionId);
                return;
            }
            // Where the stack goes next is `tuiPickerAfterSelection`'s rule.
            // A confirmation overrides it: it is its own modal level, and the
            // menu would sit open behind it.
            settingsPicker = confirmingFullAccess
                    || previousPicker?.kind === "extension"
                ? undefined
                : tuiPickerAfterSelection(selection, previousPicker);
        }
        if (sessionTrashCandidate !== undefined) {
            composer.blur();
            sessionTrashConfirmView.update(sessionTrashCandidate.label);
            sessionTrashConfirmView.box.focus();
        } else if (settingsPicker === undefined) {
            closeSettingsPickerSurface();
        } else {
            composer.blur();
            settingsPickerView.update(settingsPicker);
            settingsPickerView.box.focus();
        }
        if (returningToModelPicker) {
            requestAgentSettings(focusedAgentClient());
        }
        renderState();
    }

    /**
     * Take the picker card off the screen and give the composer the cursor back.
     *
     * Clearing `settingsPicker` is not enough on its own: the card is a
     * renderable that stays visible until it is hidden, so a path that closes
     * the pane and returns early has to come through here or it leaves a dead
     * card over the transcript it just started writing to.
     */
    function closeSettingsPickerSurface(): void {
        settingsPickerView.box.visible = false;
        settingsPickerAgent = undefined;
        if (pendingUiRequest === undefined) {
            composer.focus();
        }
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
    function switchToClient(
        next: TuiAgentClient,
        draft?: TuiDraft,
        options: { readonly preserveSidebar?: boolean } = {},
    ): void {
        const previous = client;
        clientGeneration += 1;
        // The old session owned these calls; nothing will answer them now.
        for (const pending of [...pendingConsults.values()]) {
            pending.reject(new Error("The conversation changed"));
        }
        client = next;
        setTuiWorkspaceRoot(next.workspace ?? process.cwd());
        void previous.detach().catch(() => previous.close());

        // The sidebar and any mentions belonged to the conversation being
        // left, so the client takes them down and each extension is told to
        // let go of whatever else it was holding.
        if (options.preserveSidebar !== true) {
            const previousSidebarAgent = sidebarAgentPane;
            sidebarAgentPane = undefined;
            sidebarAgentMention = undefined;
            sidebarModeLabel = undefined;
            void previousSidebarAgent?.detach().catch(() =>
                previousSidebarAgent.close()
            );
            sidebarOwner = undefined;
            clearSidebarEntryNodes();
            sidebar.clear();
            sidebar.setHeader(undefined);
            sidebar.close();
            forgetPersistedAgentPane(previous.agentId);
            extensionMentions = [];
            extensionAddressee = undefined;
        }
        rememberOpenPaneGroup();
        clientExtensionRegistry?.conversationChanged();

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
        namePrompt = undefined;
        preferencesList = undefined;
        preferencesListParent = undefined;
        confirmingFullAccess = false;
        admissionDialog = undefined;
        admissionReturnPicker = undefined;
        hostExtensionCommands = [];
        extensionCommandsLoading = next.listExtensionCommands !== undefined;
        watchBackgroundAgents(next);
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
        const openingInSidebar = sidebar.isFocused()
            && sidebarAgentPane !== undefined;
        settingsPicker = undefined;
        if (sessionId !== undefined && sessionId === client.agentId) {
            // The row for the session already on screen. Tearing down that
            // session's own transcript to put it back is a worse answer to
            // "this one" than simply leaving.
            sidebar.setFocused(false);
            settingsPickerView.box.visible = false;
            focusActiveSurface();
            renderState();
            return;
        }
        if (
            openingInSidebar
            && sessionId !== undefined
            && sessionId === sidebarAgentPane?.agentId
        ) {
            settingsPickerView.box.visible = false;
            focusActiveSurface();
            renderState();
            return;
        }
        if (dependencies.resumeSession === undefined) {
            state = appendTuiError(state, "Switching sessions is unavailable");
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
        void withSessionSwitchDeadline(
            dependencies.resumeSession(sessionPath),
            discardSwitchTarget,
        ).then(async (next) => {
            if (shuttingDown) {
                discardSwitchTarget(next);
                return;
            }
            if (openingInSidebar) {
                await openExtensionAgent(
                    "vera.tui.agent-attachments",
                    requireIdentifiedClient(next),
                    "sidebar",
                    true,
                    sessionId,
                );
                sessionSwitchPending = false;
                return;
            }
            switchToClient(next, draft);
        }).catch((error) => {
            if (shuttingDown) return;
            sessionSwitchPending = false;
            state = appendTuiError(
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
            state = appendTuiError(
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
                            false,
                            new Date(),
                            false,
                            sharedSessionGroups,
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
                state = appendTuiError(
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
            state = appendTuiError(
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
        target: TuiAgentClient = focusedAgentClient(),
    ): void {
        const requestId = randomUUID();
        requestedModelChanges.set(requestId, subject);
        void target.send({
            type: "update_model_settings",
            requestId,
            patch,
        }).catch(reportConnectionError);
        showStatusNotice(toast);
    }

    /**
     * What each live `pool_add` asked for, so an unavailable verdict can be
     * sent again without the user re-picking the model.
     */
    const poolAdmissionAttempts = new Map<string, {
        readonly provider: string;
        readonly model: string;
        readonly verify: boolean;
        readonly retry: boolean;
    }>();

    /**
     * One silent second run when a provider was unreachable, because that
     * verdict is usually a blip and the first thing a user does is ask again.
     * Answers whether the verdict was swallowed: the caller then skips it, and
     * the failed checklist comes back off the transcript so the retry replaces
     * it rather than stacking under it. A retry that fails too is reported.
     */
    function retryPoolAdmission(
        requestId: string,
        verdict: string,
    ): boolean {
        const attempt = poolAdmissionAttempts.get(requestId);
        poolAdmissionAttempts.delete(requestId);
        if (
            attempt === undefined || attempt.retry || verdict !== "unavailable"
        ) {
            return false;
        }
        state = dropTuiAdmission(state, requestId);
        const retryId = requestPoolAdmission(
            attempt.provider,
            attempt.model,
            attempt.verify,
            true,
        );
        const poolChange = pendingPoolChanges.get(requestId);
        pendingPoolChanges.delete(requestId);
        if (poolChange !== undefined) {
            pendingPoolChanges.set(retryId, poolChange);
        }
        const pendingUndo = pendingPoolUndos.get(requestId);
        pendingPoolUndos.delete(requestId);
        if (pendingUndo !== undefined) {
            pendingPoolUndos.set(retryId, pendingUndo);
        }
        if (admissionDialog?.requestId === requestId) {
            admissionDialog = startTuiAdmissionDialog(
                attempt.provider,
                attempt.model,
                retryId,
            );
        }
        if (pendingPoolName?.requestId === requestId) {
            pendingPoolName = { ...pendingPoolName, requestId: retryId };
        }
        return true;
    }

    /**
     * Sends `pool_add` and opens the admission checklist in the transcript.
     * The reply is a stream rather than one update, so the checklist entry is
     * created here and rewritten by the progress updates as they land. The
     * transcript entry is written whether or not the dialog is showing: it is
     * the durable record, and the only surface a reattached client gets.
     */
    function requestPoolAdmission(
        provider: string,
        model: string,
        verify = false,
        retry = false,
    ): string {
        const requestId = randomUUID();
        poolAdmissionAttempts.set(requestId, { provider, model, verify, retry });
        state = beginTuiAdmission(state, requestId, `${provider}/${model}`);
        sendCommand({
            type: "pool_add",
            requestId,
            provider,
            model,
            ...(verify ? { verify: true } : {}),
        });
        renderState();
        return requestId;
    }

    /** The live admission record for the dialog's own request, if any. */
    function dialogAdmission() {
        return state.admission !== undefined
                && state.admission.requestId === admissionDialog?.requestId
            ? state.admission
            : undefined;
    }

    /**
     * Verification on demand: the probes go out immediately, and the dialog
     * is the checklist they report into. The model pane, when one is open, is
     * set aside rather than closed so leaving the dialog can put the user back
     * where they were.
     */
    function openVerifyDialog(provider: string, model: string): void {
        admissionReturnPicker = settingsPicker?.kind === "model"
            ? settingsPicker
            : undefined;
        settingsPicker = undefined;
        const requestId = requestPoolAdmission(provider, model, true);
        admissionDialog = startTuiAdmissionDialog(provider, model, requestId);
        composer.blur();
        renderState();
        focusActiveSurface();
    }

    function closeAdmissionDialog(reopenPoolPicker: boolean): void {
        const returnPicker = admissionReturnPicker;
        admissionDialog = undefined;
        admissionReturnPicker = undefined;
        if (reopenPoolPicker && returnPicker !== undefined) {
            // Rebuilt rather than restored: the pool changed under the saved
            // pane, and a fresh open lands on the Pool tab, where the newly
            // admitted row is.
            openModelPicker(returnPicker.parent);
            return;
        }
        settingsPicker = returnPicker;
        focusActiveSurface();
        renderState();
    }

    function requestPermissionsChange(
        mode: string,
        target: TuiAgentClient = focusedAgentClient(),
    ): void {
        const requestId = randomUUID();
        requestedPermissionChanges.set(requestId, `permissions to ${mode}`);
        void target.send({
            type: "update_permissions",
            requestId,
            mode,
        }).catch(reportConnectionError);
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
        app.backgroundColor = theme.background;
        quoteText.fg = theme.muted;
        heldAddressText.fg = theme.muted;
        queuedPromptText.fg = theme.muted;
        jumpToBottomText.fg = theme.background;
        jumpToBottomText.bg = theme.accent;
        jumpToBottom.backgroundColor = theme.accent;
        sidebarJumpText.fg = theme.background;
        sidebarJumpText.bg = theme.accent;
        sidebarJump.backgroundColor = theme.accent;
        paneStatusText.fg = theme.muted;
        modeToastText.fg = theme.text;
        modeToastText.bg = theme.panel;
        modeToast.backgroundColor = theme.panel;
        commandSuggestionsText.fg = theme.text;
        commandSuggestionsBox.backgroundColor = theme.background;
        composerBox.backgroundColor = theme.background;
        composerBox.borderColor = theme.element;
        composerStatusText.fg = theme.muted;
        composerRule.borderColor = theme.element;
        composer.backgroundColor = theme.background;
        composer.focusedBackgroundColor = theme.background;
        composer.textColor = theme.text;
        composer.focusedTextColor = theme.text;
        composer.cursorColor = theme.accent;
        approvalView.box.backgroundColor = theme.panel;
        approvalView.repaint();
        questionView.box.backgroundColor = theme.panel;
        questionView.bar.borderColor = theme.accent;
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
        diagnosticsDialogView.box.backgroundColor = theme.panel;
        diagnosticsDialogView.repaint();
        // The column is built once and outlives any number of themes, and the
        // blocks in it were painted when they arrived.
        sidebar.setTheme(sidebarTheme(), markdownStyle);

        if (announce) {
            state = appendTuiNotice(state, `theme changed: ${selectedTheme}`);
        }
        renderState();
    }

    /**
     * Every name the user could type for a pooled model, ids included.
     *
     * `self` leads, because whatever is asking for a model is asking from
     * inside a conversation that already has one, and the same model is the
     * answer often enough to be the one already under the cursor.
     */
    function pooledModelNames(): readonly string[] {
        const names: string[] = ["self"];
        for (const entry of state.modelSettings?.pooled ?? []) {
            if (entry.poolName !== undefined) {
                names.push(entry.poolName);
            }
            names.push(entry.model);
        }
        return names;
    }

    /**
     * The half-typed token the composer can finish, and what it completes
     * from. A command argument comes from the pool; an `@` comes from whoever
     * claimed mentions.
     */
    function activeCompletion(): {
        prefix: string;
        values: readonly string[];
    } | undefined {
        const argument = commandRegistry.argumentPrefix(composer.plainText);
        if (argument !== undefined) {
            return {
                prefix: argument.prefix,
                // Bare names: the argument is the name itself, not a mention.
                values: argument.kind === "mention"
                    ? visibleMentions()
                    : pooledModelNames(),
            };
        }
        const mentions = visibleMentions();
        if (mentions.length === 0) return undefined;
        const mention = /(?:^|\s)(@\S*)$/.exec(composer.plainText);
        if (mention === null) return undefined;
        return {
            prefix: mention[1] ?? "",
            values: mentions.map((name) => `@${name}`),
        };
    }

    function renderCommandSuggestions(): void {
        // Measured off the composer's own margin, which the status card below
        // it grows and shrinks: a fixed offset here lands inside the composer
        // as soon as that card is taller than the single line it replaced.
        // These transient lines sit above the composer in normal flow, so the
        // overlay clears whichever of them are currently visible instead of
        // painting over quote/address context.
        positionCommandSuggestions();
        if (composer.plainText.length === 0) {
            commandSuggestionIndex = 0;
        }
        const completing = activeCompletion();
        if (completing !== undefined) {
            argumentSuggestions = tuiArgumentSuggestions(
                completing.values,
                completing.prefix,
            );
            commandSuggestionIndex = Math.min(
                commandSuggestionIndex,
                Math.max(0, argumentSuggestions.length - 1),
            );
            commandSuggestionsText.content = renderTuiArgumentSuggestions(
                argumentSuggestions,
                commandSuggestionIndex,
            );
            commandSuggestionsBox.height = Math.max(
                1,
                argumentSuggestions.length,
            );
            commandSuggestionsBox.visible = argumentSuggestions.length > 0
                && overlaysClearOfSuggestions();
            return;
        }
        argumentSuggestions = [];
        const suggestions = commandRegistry.suggestions(composer.plainText);
        if (composer.plainText !== "/") {
            // A list that just opened has a first row, not a chosen one.
            commandSuggestionMoved = false;
        }
        commandSuggestionIndex = Math.min(
            commandSuggestionIndex,
            Math.max(0, suggestions.length - 1),
        );
        const selected = composer.plainText === "/"
            ? commandSuggestionIndex
            : -1;
        // The transcript, the composer and the status rows all want the same
        // screen. What is left over is what the list may take, and it never
        // takes so much that its own bottom row is off the pane.
        const window = tuiSuggestionWindow(
            suggestions.length,
            selected,
            Math.max(3, renderer.height - SUGGESTIONS_RESERVED_ROWS),
        );
        commandSuggestionsText.content = renderTuiCommandSuggestions(
            suggestions.slice(window.start, window.start + window.rows),
            selected < 0 ? -1 : selected - window.start,
            // Less the box's own horizontal padding, or the last word of a
            // just-too-long row wraps anyway.
            renderer.width > 2
                ? renderer.width - 2
                : undefined,
            window.hidden,
        );
        commandSuggestionsBox.height = suggestions.length > 0
            ? window.rows + (window.hidden > 0 ? 1 : 0)
            : 1;
        commandSuggestionsBox.visible = suggestions.length > 0
            && overlaysClearOfSuggestions();
    }

    function overlaysClearOfSuggestions(): boolean {
        return focusedUiRequest() === undefined
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

    function showModeToast(message: string): void {
        modeToastVersion += 1;
        const version = modeToastVersion;
        modeToastText.content = message;
        modeToast.width = message.length + 4;
        modeToast.visible = true;
        setTimeout(() => {
            if (modeToastVersion !== version) return;
            modeToast.visible = false;
        }, MODE_TOAST_DURATION_MS);
    }

    /**
     * Shows the jump-to-bottom pill whenever the transcript is not pinned to
     * the bottom.
     *
     * Streaming grows the transcript rather than being held in a fixed live
     * area, so the cost of scrolling up mid-turn is losing the stream, not a
     * moving viewport. The pill is the way back. It is positioned absolutely
     * over the transcript's last row so showing and hiding it never reflows
     * anything, which is the whole point.
     */
    function renderJumpToBottom(): void {
        const following = transcript.scrollTop
            >= transcript.scrollHeight - transcript.viewport.height;
        const visible = !following && !anyOverlayOpen();
        jumpToBottom.visible = visible;
        if (!visible) {
            return;
        }
        jumpToBottom.top = transcript.y + transcript.height - 1;
        jumpToBottom.left = Math.max(
            0,
            transcript.x + transcript.width - JUMP_TO_BOTTOM_LABEL.length - 2,
        );
    }

    function renderSidebarJump(): void {
        const visible = sidebar.isShown() && !sidebar.isFollowing()
            && !anyOverlayOpen();
        sidebarJump.visible = visible;
        if (!visible) {
            return;
        }
        const region = sidebar.bounds();
        sidebarJump.top = region.y + region.height - 1;
        sidebarJump.left = Math.max(
            0,
            region.x + region.width - SIDEBAR_JUMP_LABEL.length - 1,
        );
    }

    /**
     * The quote line, redrawn on the status tick as well as on state, because
     * the mark blinks and nothing else is changing while it does.
     */
    function renderPendingQuote(): void {
        const quote = pendingQuote;
        quoteText.visible = quote !== undefined && !anyOverlayOpen();
        setComposerMargin(quoteText.visible ? 3 : 2);
        if (quote === undefined) {
            quoteText.content = "";
            return;
        }
        const { facts, keys } = renderTuiQuote(quote);
        // Indented by hand: the line is one row in a column that does not pad
        // its children, and it has to start where the composer's text starts.
        quoteText.content = new StyledText([
            fg(TUI_ACCENT)(`${tuiQuoteMarker(Date.now())} `),
            fg(TUI_MUTED)(`${facts} · `),
            fg(TUI_ACCENT)(keys),
        ]);
    }

    /** The pinned line naming who the composer is holding for. */
    function renderHeldAddress(): void {
        const { facts, keys } = renderTuiHeldAddress(extensionAddressee);
        heldAddressText.visible = facts.length > 0 && !anyOverlayOpen();
        if (facts.length === 0) {
            heldAddressText.content = "";
            return;
        }
        // Indented by hand: the row sits in a column that does not pad its
        // children, and it has to start where the composer's text starts.
        heldAddressText.content = new StyledText([
            fg(TUI_MUTED)(`  ${facts} · `),
            fg(TUI_ACCENT)(keys),
        ]);
    }

    function renderStatus(): void {
        if (shuttingDown) {
            return;
        }
        const statusState = focusedAgentState();
        const uiRequest = focusedUiRequest();
        const focusedSide = sidebar.isFocused() ? sidebarAgentPane : undefined;
        const focusedAbort = focusedAbortRequested();
        const focusedActivity = focusedSide?.state.activity ?? activity;
        const focusedElapsed = focusedSide?.state.elapsedWorkingTime()
            ?? elapsedWorkingTime();
        const layout = sidebar.layout();
        const mainPaneActivity = state.working
            ? activity
            : pendingUiRequest === undefined ? "idle" : "waiting";
        const sidePaneActivity = sidebarAgentPane?.state.state.working
            ? sidebarAgentPane.state.activity
            : sidebarAgentPane?.state.pendingUiRequest === undefined
            ? "idle"
            : "waiting";
        const mainPaneStatus = `Vera · ${state.approvalMode ?? "loading"} · ${mainPaneActivity}`;
        const sidePaneStatus = sidebarAgentPane === undefined
            ? ""
            : `${sidebarAgentMention ?? sidebarAgentPane.agentId} · ${sidebarAgentPane.state.state.approvalMode ?? "loading"} · ${sidePaneActivity}`;
        // Only when there are two panes to tell apart: an empty row still
        // takes a line under the frame.
        paneStatusText.visible = sidebarAgentPane !== undefined
            && !anyOverlayOpen();
        paneStatusText.content = sidebarAgentPane === undefined
            ? ""
            : layout === "split"
            ? new StyledText([
                fg(sidebar.isFocused() ? TUI_MUTED : TUI_ACCENT)(
                    mainPaneStatus,
                ),
                fg(TUI_MUTED)("   |   "),
                fg(sidebar.isFocused() ? TUI_ACCENT : TUI_MUTED)(
                    sidePaneStatus,
                ),
            ])
            : layout === "sidebar"
            ? new StyledText([fg(TUI_ACCENT)(sidePaneStatus)])
            : new StyledText([fg(TUI_ACCENT)(mainPaneStatus)]);
        const workingHint = focusedSide === undefined
            ? WORKING_HINT
            : `enter queue → ${sidebarAgentMention ?? focusedSide.agentId}`
                + ` · esc stop ${sidebarAgentMention ?? focusedSide.agentId}`
                + ` · ${tuiKeyHint("interrupt")}`;
        renderPendingQuote();
        renderHeldAddress();
        renderJumpToBottom();
        renderSidebarJump();

        let lifecycleHint = renderTuiIdleHint(
            READY_HINT,
            runningBackgroundAgents,
        );
        if (connectionFailed) {
            lifecycleHint = "disconnected · /reconnect host · ctrl+c quit";
        } else if (focusedAbort) {
            lifecycleHint = `${STOPPING_HINT} · ${focusedElapsed}`;
        } else if (
            uiRequest !== undefined
            && isToolApprovalUiRequestUpdate(uiRequest)
        ) {
            lifecycleHint = tuiApprovalHint(uiRequest);
        } else if (uiRequest?.request.type === "user_question") {
            lifecycleHint = `${QUESTION_HINT} · ${focusedElapsed}`;
        } else if (statusState.working) {
            const modelActivity = statusState.modelActivity;
            const waitingToRetry = modelActivity !== undefined
                && Date.parse(modelActivity.retryAt) > Date.now();
            lifecycleHint = waitingToRetry
                ? `retrying · attempt ${modelActivity.nextAttempt}/${modelActivity.maxAttempts}`
                    + ` · ${focusedElapsed} · ${workingHint}`
                : `${modelActivity === undefined ? focusedActivity : "thinking"}`
                    + ` · ${focusedElapsed} · ${workingHint}`;
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

        statusText.fg = statusState.approvalMode === "full_access"
            ? "#ff3b30"
            : statusNotice !== undefined
            ? TUI_NOTICE
            : statusState.working
                    || uiRequest !== undefined
                    || extensionCommandPending
                ? TUI_ACCENT
                : TUI_MUTED;
        const quietAttachedPane = sidebarAgentPane !== undefined
            && statusNotice === undefined
            && !statusState.working
            && uiRequest === undefined
            && lifecycleHint === READY_HINT;
        const statusLine = quietAttachedPane
            ? ""
            : statusNotice ?? lifecycleHint;
        statusText.visible = !(approvalView.box.visible
            || questionView.box.visible);
        // Pull on repaint: the renderer is handed the snapshot and answers
        // synchronously, or it does not answer at all. Nothing here waits on
        // an extension, and a renderer that fails leaves the built-in line.
        const extensionSegments = clientExtensionRegistry?.renderStatusLine(
            tuiStatusSnapshot(
                statusState.modelSettings,
                statusState.approvalMode,
                statusState.context,
                process.cwd(),
                runningBackgroundAgents,
                state.working
                    ? "working"
                    : uiRequest === undefined
                        ? "idle"
                        : "waiting",
            ),
        );
        const statusDetailsRows: TuiStatusChunk[][] =
            extensionSegments === undefined
                ? renderTuiStatusDetailsRows(
                    statusState.modelSettings,
                    statusState.approvalMode,
                    statusState.context,
                    process.cwd(),
                    0,
                    statusState.effortSubstitution,
                    sidebarAgentPane === undefined,
                    workspaceBranch.current(),
                )
                : [[{
                    tone: "muted",
                    text: renderTuiStatusSegments(
                        sidebarAgentPane === undefined
                            ? extensionSegments
                            : extensionSegments.filter((segment) =>
                                segment.kind !== "permissions"
                            ),
                    ),
                }]];
        // What an extension has made true of this conversation, said where the
        // rest of the conversation's state is said. The sidebar is a whole
        // column that arrived without being asked for, so the key that takes
        // it away is only offered while it is there.
        const extensionState = [
            ...(sidebarAgentPane === undefined
                ? []
                : [
                    `${sidebarModeLabel ?? sidebarAgentMention ?? "agent"} mode`,
                    sidebar.layout() === "split"
                        ? "split"
                        : sidebar.layout() === "sidebar"
                        ? `${sidebarModeLabel ?? sidebarAgentMention ?? "agent"} only`
                        : "vera only",
                    "ctrl+/ layout",
                ]),
            ...(sidebarAgentPane !== undefined && sidebar.layout() === "split"
                ? [sidebar.isFocused()
                    ? "ctrl+g main"
                    : `ctrl+g ${sidebarAgentMention ?? sidebarAgentPane.agentId}`]
                : []),
        ];
        // Extension state joins the place row: it says something about how the
        // session is arranged, and that row is the one a narrow terminal can
        // most afford to clip.
        const detailsRows = extensionState.length === 0
            ? statusDetailsRows
            : statusDetailsRows.map((row, index) =>
                index === statusDetailsRows.length - 1
                    ? [...row, {
                        tone: "muted" as const,
                        text: ` · ${extensionState.join(" · ")}`,
                    }]
                    : row
            );
        const runningNames = runningBackgroundAgentNames.map((name) =>
            truncateFooterLine(
                `* ${name}`,
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
            : activityAnimation === "shimmer"
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
        // The card's own inner width, past the band's indent, its border and
        // its padding: the rules drawn inside it have to stop where it does.
        const cardWidth = Math.max(1, renderer.width - 8);
        const rule = (glyph: string) =>
            fg(TUI_ELEMENT)(`${glyph.repeat(cardWidth)}\n`);
        // The first row says what the session is answering as, and it lives
        // inside the composer's frame: it is a property of the thing being
        // typed into. What is left describes where the session is, and reads
        // under the frame.
        const insideRow = detailsRows[0] ?? [];
        const outsideRows = detailsRows.slice(1);
        composerStatusText.content = new StyledText(
            insideRow.map((chunk) => fg(statusToneColor(chunk.tone))(chunk.text)),
        );
        const detailChunks = outsideRows.flatMap((row, index) => [
            ...row.map((chunk) => fg(statusToneColor(chunk.tone))(chunk.text)),
            ...(index === outsideRows.length - 1
                ? []
                : [fg(TUI_MUTED)("\n"), rule("─")]),
        ]);
        backgroundStatusText.content = new StyledText([
            ...detailChunks,
            ...(agentSection.length === 0 ? [] : [
                fg(TUI_MUTED)("\n"),
                rule("·"),
                ...animatedAgentHeader.chunks,
                fg(TUI_MUTED)(
                    agentSection.length === 1
                        ? ""
                        : `\n${agentSection.slice(1).join("\n")}`,
                ),
            ]),
        ]);
        // A rule between every pair of rows under the frame, and one more
        // above the agent section when there is one.
        const cardRows = Math.max(1, outsideRows.length * 2 - 1)
            + (agentSection.length === 0 ? 0 : 1 + agentSection.length);
        backgroundStatusText.height = cardRows;
        // The band's own rows, which the composer sits straight on top of with
        // no gutter of its own: the card, its border lines, and whichever
        // status lines are showing above it.
        setComposerMargin(
            cardRows + (paneStatusText.visible ? 1 : 0),
        );
        statusText.content = statusState.working
                && statusNotice === undefined
                && uiRequest === undefined
                && !focusedAbort
            ? renderTuiActivityAnimation(
                activityAnimation,
                activityFrame(),
                statusLine,
                {
                    active: TUI_ACCENT,
                    // The trail is part of Vera's ActiveGrid identity, not a
                    // success indicator inherited from the selected theme.
                    trail: activityAnimation === "shimmer"
                        ? TUI_ELEMENT
                        : VERA_TUI_THEME.success,
                    inactive: TUI_MUTED,
                    text: state.approvalMode === "full_access"
                        ? "#ff3b30"
                        : TUI_ACCENT,
                },
                activityAnimationWidth,
            )
            : statusLine;
    }

    /**
     * Follow one session's background work, from the attach onwards.
     *
     * The host sends the current facts with the attach and again whenever they
     * change, so there is nothing to poll and nothing to wait for: the first
     * paint after a switch is already right.
     */
    function watchBackgroundAgents(next: TuiAgentClient): void {
        stopWatchingBackgroundAgents?.();
        stopWatchingBackgroundAgents = undefined;
        applyBackgroundAgents(next.backgroundAgents);
        stopWatchingBackgroundAgents = next.onBackgroundAgents?.((agents) => {
            if (client !== next || shuttingDown) {
                return;
            }
            applyBackgroundAgents(agents);
            renderStatus();
        });
    }

    function applyBackgroundAgents(
        agents: BackgroundAgentsSnapshot | undefined,
    ): void {
        runningBackgroundAgents = agents?.running ?? 0;
        runningBackgroundAgentNames = agents?.children ?? [];
        currentAgentHasParent = agents?.has_parent ?? false;
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
            ?? (activityAnimation === "shimmer"
                ? SHIMMER_FRAME_INTERVAL_MS
                : activityAnimation === "symmetric_wave"
                ? SYMMETRIC_WAVE_FRAME_INTERVAL_MS
                : DEFAULT_ACTIVITY_FRAME_INTERVAL_MS);
        return Math.floor(Date.now() / interval);
    }

}

function recentSessionSaveFailure(error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    return `Could not remember this session for vera -c: ${detail}`;
}

/** What a patch asks for, as `provider/model at effort`. */
function describeModelPatch(patch: ModelSettingsPatch): string {
    const model = patch.model === undefined
        ? undefined
        : patch.provider === undefined
        ? patch.model
        : `${patch.provider}/${patch.model}`;
    const effort = patch.reasoningEffort;
    const parts = [
        model,
        effort === undefined
            ? undefined
            : model === undefined ? effort : `at ${effort}`,
    ];
    return parts.filter((part) => part !== undefined).join(" ");
}

function modelPatchSubject(patch: ModelSettingsPatch): string {
    return patch.model === undefined
        ? `the reasoning effort to ${describeModelPatch(patch)}`
        : `the model to ${describeModelPatch(patch)}`;
}

function rejectionNotice(
    subject: string,
    reason: "invalid" | "unavailable",
): string {
    return reason === "unavailable"
        ? `Changing ${subject} is unavailable on this host`
        : `Could not change ${subject}`;
}
