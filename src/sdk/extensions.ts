import type { JsonValue } from "./hooks.ts";
import type {
    ModelRequestHook,
    PostToolUseHook,
    PreToolUseHook,
} from "./hooks.ts";
import type { ExtensionCommandBody } from "../extensions/commands.ts";
import type {
    StatusLineSegment,
    StatusLineSnapshot,
} from "../extensions/status-line.ts";
import type { ModelReasoningEffort } from "../model/types.ts";
import type { ToolPresentation } from "../model/types.ts";
import type { PermissionInputSpec } from "../tools/types.ts";
import type { VeraClientExperimentalTui } from "./experimental-tui.ts";

export interface VeraExtensionApi {
    readonly config: JsonValue;
    readonly commands: VeraExtensionCommands;
    readonly tools: VeraExtensionTools;
    readonly agents: VeraExtensionAgents;
    readonly hooks: VeraExtensionHooks;
    readonly storage: VeraExtensionStorage;
    onDispose(dispose: VeraExtensionDisposer): void;
}

/**
 * Where an extension keeps its own state, one directory per extension, created
 * on first read. `profile` belongs to the installation the user selected and is
 * the default; `machine` is for the rare state that has to be one picture for
 * the whole machine no matter which profile is running.
 */
export interface VeraExtensionStorage {
    readonly profile: string;
    readonly machine: string;
}

export type VeraExtensionDisposer = () => void | Promise<void>;

export interface VeraExtensionModule {
    activate(vera: VeraExtensionApi): void | Promise<void>;
}

export interface VeraExtensionCommands {
    register(spec: VeraExtensionCommandSpec): void;
}

export interface VeraExtensionTools {
    register(spec: VeraExtensionToolSpec): void;
}

/**
 * Agents an extension ships.
 *
 * The lowest-precedence source: a file of the same name in the project or the
 * user's profile shadows it, and the `[d]` writer refuses it, because there is
 * no file of the extension's to write into.
 */
export interface VeraExtensionAgents {
    register(spec: VeraExtensionAgentSpec): void;
}

export interface VeraExtensionAgentSpec {
    readonly name: string;
    readonly description?: string;
    readonly instructions: string;
    /** Omitted means every tool. Present is a restriction to exactly these. */
    readonly tools?: readonly string[];
    readonly skills?: readonly string[];
    readonly posture?: string;
    readonly defaultPair?: {
        readonly name: string;
        readonly effort?: string;
    };
    readonly nudges?: readonly {
        readonly on: string;
        readonly text: string;
    }[];
}

export interface VeraExtensionHooks {
    registerPreToolUse(hook: PreToolUseHook): VeraExtensionDisposer;
    registerPostToolUse(hook: PostToolUseHook): VeraExtensionDisposer;
    registerModelRequest(
        namespace: string,
        hook: ModelRequestHook,
    ): VeraExtensionDisposer;
    registerCommand(spec: VeraExtensionCommandHookSpec): VeraExtensionDisposer;
}

export interface VeraExtensionCommandHookSpec {
    readonly phase: "pre_tool_use" | "post_tool_use";
    /** Executable plus arguments; never interpreted by a shell. */
    readonly argv: readonly string[];
    /** Wire format used on stdin/stdout. Defaults to Vera's native format. */
    readonly protocol?: "vera" | "claude";
    readonly timeoutMs?: number;
}

export interface VeraExtensionToolSpec {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
    readonly parallel?: boolean;
    readonly permissionOperation?: string;
    readonly permissionInputs?: readonly PermissionInputSpec[];
    readonly run: VeraExtensionToolHandler;
}

export interface VeraExtensionToolRequest {
    readonly input: Readonly<Record<string, unknown>>;
    readonly workspace: string;
    readonly signal: AbortSignal;
}

export interface VeraExtensionToolResult {
    readonly output: string;
    readonly isError?: boolean;
    /**
     * Optional client-facing rendering kept outside model input. The engine
     * persists and publishes it only after the tool result is durable.
     */
    readonly presentation?: ToolPresentation;
}

export type VeraExtensionToolHandler = (
    request: VeraExtensionToolRequest,
) => VeraExtensionToolResult | Promise<VeraExtensionToolResult>;

export interface VeraExtensionCommandSpec {
    readonly name: string;
    readonly description: string;
    readonly usage: string;
    readonly run: VeraExtensionCommandHandler;
}

export interface VeraExtensionCommandRequest {
    readonly argumentsText: string;
    readonly workspace: string;
    readonly signal: AbortSignal;
}

export type VeraExtensionCommandHandler = (
    request: VeraExtensionCommandRequest,
) => ExtensionCommandBody | Promise<ExtensionCommandBody>;

export interface VeraClientExtensionApi {
    readonly config: JsonValue;
    readonly commands: VeraClientExtensionCommands;
    readonly compose: VeraClientExtensionCompose;
    readonly preferences: VeraClientExtensionPreferences;
    readonly modelSettings: VeraClientExtensionModelSettings;
    readonly ui: VeraClientExtensionUi;
    readonly keybindings: VeraClientExtensionKeybindings;
    readonly statusLine: VeraClientExtensionStatusLine;
    readonly messages: VeraClientExtensionMessages;
    readonly thread: VeraClientExtensionThread;
    readonly conversation: VeraClientExtensionConversation;
    readonly consult: VeraClientExtensionConsult;
    readonly agents: VeraClientExtensionAgents;
    readonly tips: VeraClientExtensionTips;
    /** Experimental, TUI-only component host. Not a portable SDK surface. */
    readonly experimentalTui: VeraClientExperimentalTui;
    onDispose(dispose: VeraExtensionDisposer): void;
}

export type VeraClientAgentPane = "main" | "sidebar";
export type VeraClientAgentAttachmentLifetime = "ephemeral" | "durable";

export interface VeraClientAgentRef {
    readonly agentId: string;
}

export interface VeraClientVisibleAgent {
    readonly agentId: string;
    readonly pane: VeraClientAgentPane;
    readonly mention?: string;
}

export interface VeraClientAgentCreateRequest {
    readonly pane: VeraClientAgentPane;
    readonly attachmentLifetime?: VeraClientAgentAttachmentLifetime;
    readonly mention?: string;
    readonly statusLabel?: string;
    readonly workspace?: string;
    readonly approvalMode?: string;
    /** Create from an existing hosted agent instead of a fresh session. */
    readonly source?: {
        readonly type: "branch";
        readonly agentId: string;
    };
    /** Keep inherited context model-visible but out of this pane's transcript. */
    readonly hideInheritedMessages?: boolean;
    /** Model context appended after a branch and before its first turn. */
    readonly initialMessages?: readonly {
        readonly role: "user";
        readonly text: string;
        readonly hidden?: boolean;
        readonly compactionBarrier?: boolean;
    }[];
}

export interface VeraClientAgentOpenRequest {
    readonly agentId: string;
    readonly pane: VeraClientAgentPane;
    readonly attachmentLifetime?: VeraClientAgentAttachmentLifetime;
    readonly mention?: string;
    readonly statusLabel?: string;
}

export interface VeraClientAgentMessageRequest {
    readonly agentId: string;
    readonly text: string;
    readonly imagePaths?: readonly string[];
}

export interface VeraClientAgentContextSyncResult {
    readonly outcome:
        | "synced"
        | "unchanged"
        | "busy"
        | "stale_cursor"
        | "not_found"
        | "failed";
    readonly turns: number;
}

/**
 * Experimental client-only addressing for the two visible hosted-agent
 * participants. This is plain data and does not cross the runtime boundary.
 */
export interface VeraClientExperimentalHostedAgentAddressing {
    readonly primary: string;
    readonly secondary: string;
    readonly broadcast?: string;
}

/** Hosted-agent operations; the client owns attachment and presentation. */
export interface VeraClientExtensionAgents {
    visible(): readonly VeraClientVisibleAgent[];
    /** Sets the aliases for the extension's currently visible agent surface. */
    declareExperimentalAddressing(
        addressing: VeraClientExperimentalHostedAgentAddressing,
    ): void;
    create(
        request: VeraClientAgentCreateRequest,
        signal?: AbortSignal,
    ): Promise<VeraClientAgentRef>;
    open(
        request: VeraClientAgentOpenRequest,
        signal?: AbortSignal,
    ): Promise<void>;
    syncContext(
        agentId: string,
        signal?: AbortSignal,
    ): Promise<VeraClientAgentContextSyncResult>;
    message(
        request: VeraClientAgentMessageRequest,
        signal?: AbortSignal,
    ): Promise<void>;
}

export interface VeraClientExtensionModule {
    activateClient(vera: VeraClientExtensionApi): void | Promise<void>;
}

export interface VeraClientExtensionCommands {
    register(spec: VeraClientExtensionCommandSpec): void;
}

export interface VeraClientExtensionCommandSpec {
    readonly name: string;
    readonly description: string;
    readonly usage: string;
    readonly palette?: VeraClientExtensionPaletteEntry;
    /** Human interaction owns the lifetime; TUI close still cancels it. */
    readonly interactive?: boolean;
    /** Whether this command consumes images submitted with its invocation. */
    readonly acceptsImages?: boolean;
    /**
     * What the first argument names, so the client can complete it. The
     * client owns the list: `model` completes from the model pool, and
     * `mention` from the names this extension offered the composer.
     */
    readonly arguments?: "model" | "mention";
    /** Whether this command belongs on client surfaces and may run right now. */
    readonly when?: () => boolean;
    readonly run: VeraClientExtensionCommandHandler;
}

export interface VeraClientExtensionPaletteEntry {
    readonly label: string;
    readonly description?: string;
    readonly group?: "Session" | "Settings" | "Extensions";
    readonly keyHint?: string;
}

export interface VeraClientExtensionCommandRequest {
    readonly argumentsText: string;
    readonly workspace: string;
    readonly imageCount: number;
    readonly imagePaths: readonly string[];
    readonly signal: AbortSignal;
}

export type VeraClientExtensionCommandHandler = (
    request: VeraClientExtensionCommandRequest,
) => ExtensionCommandBody | void | Promise<ExtensionCommandBody | void>;

export interface VeraClientExtensionPreferences {
    get(key: string): Promise<JsonValue | undefined>;
    set(key: string, value: JsonValue): Promise<void>;
    delete(key: string): Promise<void>;
}

export interface VeraClientModelSettingsSnapshot {
    readonly provider?: string;
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
    /**
     * The level the user asked for, present only while the model does not
     * publish it and `reasoningEffort` is the substitute in effect.
     */
    readonly requestedReasoningEffort?: ModelReasoningEffort;
    readonly availableReasoningEfforts?: readonly ModelReasoningEffort[];
    readonly availableModels?: readonly VeraClientAvailableModel[];
    /** The pool: the models the user admitted, newest first. */
    readonly pooled?: readonly VeraClientPooledModel[];
    readonly contextWindow?: number;
}

export interface VeraClientAvailableModel {
    readonly provider: string;
    readonly model: string;
    readonly label: string;
    readonly description: string;
    readonly contextWindow?: number;
    /** Empty means the model has no reasoning control at all. */
    readonly levels: readonly VeraClientReasoningLevel[];
    readonly defaultLevel?: string;
}

/**
 * Whether one model can be run right now, and what the pool knows about it.
 * Derived from `current()`, so it answers the same question the model picker
 * answers about a row.
 */
export interface VeraClientModelAvailability {
    /** The model is offered by a connected provider, so a switch would land. */
    readonly runnable: boolean;
    readonly pooled: boolean;
    /** True once probe evidence exists; false for an unpooled model. */
    readonly verified: boolean;
}

export interface VeraClientPooledModel {
    readonly provider: string;
    readonly model: string;
    readonly label: string;
    /** The user's own name for this entry, when it has one. */
    readonly poolName?: string;
    /** False when the model cannot run right now, never a reason to omit it. */
    readonly available: boolean;
    /** True once probe or rejection evidence exists for this model. */
    readonly verified: boolean;
    readonly description?: string;
    readonly contextWindow?: number;
    readonly levels: readonly VeraClientReasoningLevel[];
    readonly defaultLevel?: string;
}

export interface VeraClientReasoningLevel {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
}

export interface VeraClientModelSettingsPatch {
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: ModelReasoningEffort | null;
}

export interface VeraClientModelSettingsAccepted {
    readonly status: "accepted";
    readonly settings: VeraClientModelSettingsSnapshot;
}

export interface VeraClientModelSettingsRejected {
    readonly status: "rejected";
    readonly reason: "invalid" | "unavailable";
}

export type VeraClientModelSettingsUpdateResult =
    | VeraClientModelSettingsAccepted
    | VeraClientModelSettingsRejected;

export type VeraClientModelSettingsListener = (
    settings: VeraClientModelSettingsSnapshot,
) => void;

export interface VeraClientExtensionModelSettings {
    current(): VeraClientModelSettingsSnapshot | undefined;
    update(
        patch: VeraClientModelSettingsPatch,
        signal?: AbortSignal,
    ): Promise<VeraClientModelSettingsUpdateResult>;
    onChanged(listener: VeraClientModelSettingsListener): VeraExtensionDisposer;
    /**
     * Whether a given model could be switched to right now. Read-only, and
     * derived from the same snapshot `current()` returns, so an extension does
     * not have to re-implement the runnable, pooled and verified rules. An
     * omitted provider matches the model on any provider.
     *
     * Capability: `client.model_settings`, the one `current()` already needs.
     */
    availability(
        model: { readonly provider?: string; readonly model: string },
    ): VeraClientModelAvailability;
    /**
     * The current model's own reasoning levels, most capable first. Derived
     * from `current().availableModels` by matching provider and model, the
     * same lookup the TUI's own level pane does, so an extension never has
     * to carry that filter itself. Empty when the model is unrecognised or
     * has no reasoning control at all; that is not an error.
     */
    currentLevels(): readonly VeraClientReasoningLevel[];
    /**
     * Which of `currentLevels()` the model is actually sitting on, by id.
     * This is not always `current().reasoningEffort`: that field holds what
     * the user last asked for, which may be a word this model does not know,
     * and placing it is a rule extensions must not re-derive. Undefined only
     * when there is nothing to sit on, matching an empty `currentLevels()`.
     */
    currentLevel(): string | undefined;
}

export interface VeraClientPickerRow {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    readonly meta?: string;
    readonly current?: boolean;
}

export interface VeraClientPickerAction {
    readonly id: string;
    readonly label: string;
    readonly keys: readonly string[];
}

export interface VeraClientPickerRequest {
    readonly title: string;
    readonly subtitle?: string;
    readonly rows: readonly VeraClientPickerRow[];
    readonly selectedId?: string;
    readonly actions: readonly VeraClientPickerAction[];
}

export interface VeraClientPickerSelection {
    readonly outcome: "selected";
    readonly rowId: string;
    readonly actionId: string;
}

export interface VeraClientPickerCancellation {
    readonly outcome: "cancelled";
}

export type VeraClientPickerResult =
    | VeraClientPickerSelection
    | VeraClientPickerCancellation;

export interface VeraClientExtensionUi {
    requestPicker(
        request: VeraClientPickerRequest,
        signal?: AbortSignal,
    ): Promise<VeraClientPickerResult>;
    /**
     * Post one line into the transcript. For the thing an extension did that
     * the user would otherwise have to infer, which a keybinding especially
     * has no other way to say. The client owns where it lands and how long it
     * stays; nothing is returned, and nothing waits. Empty text is refused.
     *
     * Capability: `client.ui.notice`.
     */
    notice(
        text: string,
        options?: {
            readonly tone?: "primary" | "soft" | "error";
            /** Keep the line in transcript replay without adding model context. */
            readonly replay?: boolean;
        },
    ): void;
    /**
     * Write a labeled block into the transcript, for text long enough that a
     * notice line would not carry it: another model's answer, a summary, a
     * rendered result. Markdown is rendered.
     *
     * Capability: `client.ui.transcript`.
     */
    transcript(block: VeraClientTranscriptBlock): void;
    /**
     * A region beside the transcript that this extension owns while it is
     * open. One extension holds it at a time; opening it while another has it
     * fails rather than taking it.
     *
     * Capability: `client.ui.sidebar`.
     */
    readonly sidebar: VeraClientExtensionSidebar;
    /**
     * Names the composer completes after an `@`. The extension is the only one
     * that knows what it named, so it hands the list over; the client decides
     * how completing feels.
     *
     * Capability: `client.ui.mentions`.
     */
    readonly mentions: VeraClientExtensionMentions;
    /**
     * Who the next message is going to, when it is not the agent. The client
     * shows the name where the user is about to type, because a message that
     * leaves by a different door than usual has to say so before it is sent
     * rather than after.
     *
     * The client is told a name, not a rule: routing stays with the extension
     * that decided it.
     *
     * Capability: `client.ui.addressing`.
     */
    readonly addressing: VeraClientExtensionAddressing;
}

export interface VeraClientExtensionAddressing {
    /** A name to show, or nothing when the agent is the recipient again. */
    set(name: string | undefined): void;
}

export interface VeraClientExtensionMentions {
    /**
     * Replaces the whole list. Each name is one word, with no `@` on it and no
     * whitespace in it.
     */
    set(names: readonly string[]): void;
}

export interface VeraClientExtensionSidebar {
    /** Claims the sidebar. It is a column of blocks, with no chrome of its own. */
    open(): void;
    /** Adds a block to the bottom. Empty label or text is refused. */
    append(block: VeraClientTranscriptBlock): void;
    clear(): void;
    close(): void;
}

/**
 * A compose-time offer to wear an agent this extension ships.
 *
 * Core never guesses intent from what you are typing. A suggester does, and it
 * exists only inside an extension you installed — installing it is the
 * consent. Accepting goes through the ordinary, loud wear path.
 */
export interface VeraClientExtensionCompose {
    registerSuggester(spec: VeraClientExtensionComposeSuggesterSpec): void;
}

export interface VeraClientExtensionComposeSuggesterSpec {
    /** The agent to offer. Usually one this extension also registered. */
    readonly agent: string;
    /** One line, shown under the composer while `match` holds. */
    readonly hint: string;
    /**
     * A pure predicate over the composer's text. No network, no model calls,
     * no side effects: the client debounces it and calls it on every keystroke
     * that survives the debounce, and never on empty input.
     */
    match(text: string): boolean;
}

export interface VeraClientExtensionKeybindings {
    register(spec: VeraClientExtensionKeybindingSpec): void;
}

export interface VeraClientExtensionKeybindingSpec {
    readonly id: string;
    readonly description: string;
    readonly keys: readonly string[];
    /**
     * Where the chord applies. Absent means everywhere an extension chord can
     * be reached, which is every surface with no overlay open.
     */
    readonly scope?: string;
    /**
     * Whether the user may move this chord in `tui.json`.
     *
     * Absent means no. Only a binding that opens a visible picker should say
     * yes: a remappable key that changes state without showing anything is how
     * blind cycling gets rebuilt from the outside.
     */
    readonly remappable?: boolean;
    /** How the chord is written in a footer, when a surface shows it. */
    readonly hint?: string;
    readonly run: VeraClientExtensionKeybindingHandler;
}

export interface VeraClientExtensionKeybindingRequest {
    readonly workspace: string;
    readonly signal: AbortSignal;
}

export type VeraClientExtensionKeybindingHandler = (
    request: VeraClientExtensionKeybindingRequest,
) => void | Promise<void>;

export type VeraClientStatusSnapshot = StatusLineSnapshot;
export type VeraClientStatusSegment = StatusLineSegment;

export interface VeraClientExtensionStatusLine {
    register(spec: VeraClientExtensionStatusLineSpec): void;
}

export interface VeraClientExtensionStatusLineSpec {
    readonly render: VeraClientStatusLineRenderer;
}

export interface VeraClientExtensionTips {
    register(spec: VeraClientExtensionTipSpec): void;
}

/**
 * A line the client may show in its own tip rotation.
 *
 * The text is fixed rather than rendered on demand: a tip is prose about a
 * key, and a client that had to call out to paint one would be waiting on an
 * extension in the middle of a frame. `when` is the only code the client runs,
 * it is synchronous, and a `when` that throws is read as "not now" rather than
 * taken as a failure worth telling the user about.
 */
export interface VeraClientExtensionTipSpec {
    readonly id: string;
    readonly text: string;
    /**
     * Client launches that must pass before this tip may repeat. Defaults to
     * 10, which is deliberately shy: an extension's tip competes with the
     * client's own for one line.
     */
    readonly cooldownLaunches?: number;
    readonly when?: (context: VeraClientTipContext) => boolean;
}

/** What the client knows about itself when it asks for a tip. */
export interface VeraClientTipContext {
    /** How many times this client has been started, this start included. */
    readonly launches: number;
    readonly pooledCount: number;
    readonly namedPoolCount: number;
    readonly anyVerified: boolean;
    /** Whether the model picker is the surface asking. */
    readonly inModelPicker: boolean;
}

/**
 * Called during a repaint, so it must be synchronous and quick: returning a
 * promise counts as an invalid result, and the client keeps its own rendering
 * rather than waiting. One extension owns the whole segment list; a second
 * registration is refused at load.
 */
export type VeraClientStatusLineRenderer = (
    snapshot: VeraClientStatusSnapshot,
) => readonly VeraClientStatusSegment[];

/**
 * A block an extension writes into the transcript the user is reading.
 *
 * It is a view, not a message: nothing here reaches the model, and it is gone
 * when the conversation changes. An extension that wants the agent to see the
 * text puts it in a message instead.
 */
export interface VeraClientTranscriptBlock {
    /** Names the source, rendered above the text. */
    readonly label: string;
    readonly text: string;
    /**
     * Who is talking, for when the block is quoted into a message. The label
     * is written to be read in place and often carries more than a name, so a
     * quotation attributed to it reads badly. Defaults to the label.
     */
    readonly speaker?: string;
}

/**
 * The conversation this client is showing, as a thing that can be replaced.
 *
 * Switching conversations leaves an extension holding state about one the user
 * has left: seats, panes, anything per-conversation. The listener is where it
 * lets go. No capability gates it, since it grants nothing.
 */
export interface VeraClientExtensionConversation {
    onChanged(listener: () => void): void;
}

/**
 * The conversation between the user and the agent, as this client shows it.
 *
 * Capability: `client.thread.read`.
 */
export interface VeraClientExtensionThread {
    /**
     * A snapshot of the thread, oldest first: what the user said and what the
     * agent answered. Tool calls, notices, and extension output are not in it.
     */
    read(): readonly VeraClientThreadTurn[];
}

export interface VeraClientThreadTurn {
    readonly role: "user" | "assistant";
    readonly text: string;
}

/**
 * A second model's read on the conversation, outside the turn.
 *
 * The named model answers or the call fails. Vera never substitutes another
 * one, because an extension that asked for a specific model has no use for a
 * different model's answer. A consult runs no tools, streams nothing, and adds
 * nothing to the session.
 */
export interface VeraClientExtensionConsult {
    (request: VeraClientConsultRequest): Promise<VeraClientConsultResult>;
}

export interface VeraClientConsultRequest {
    readonly model: string;
    readonly provider?: string;
    readonly reasoningEffort?: string;
    readonly systemPrompt?: string;
    readonly messages: readonly VeraClientConsultMessage[];
    readonly maxTokens?: number;
}

export interface VeraClientConsultMessage {
    readonly role: "user" | "assistant";
    readonly content: string;
}

export interface VeraClientConsultResult {
    readonly text: string;
    /** Which model answered. Diagnostic only; it is the one that was asked. */
    readonly model: string;
    readonly provider?: string;
}

export interface VeraClientExtensionMessages {
    /**
     * See each message the user submits before the client sends it.
     *
     * Slash commands never reach an interceptor: `/name` is dispatched by the
     * client's own registry, so an interceptor sees only what would otherwise
     * become a prompt.
     */
    intercept(handler: VeraClientMessageInterceptor): void;
}

export interface VeraClientOutgoingMessage {
    /** The submitted text, with image chips and collapsed pastes expanded. */
    readonly text: string;
    readonly workspace: string;
    /** How many images travel with the message; their bytes are not exposed. */
    readonly imageCount: number;
}

/**
 * What the client does with a submitted message.
 *
 * `pass` and an absent decision mean the same thing, so an interceptor that
 * returns nothing cannot accidentally swallow a message. `replace` sends the
 * given text instead; the client keeps the original in submit history, since
 * that is what the user typed and would want to recall.
 *
 * `injectedPrefix` counts the leading characters of `text` the interceptor
 * added. The model is sent all of it, and the client shows the rest, so an
 * extension's own machinery does not read as the user's words. An interceptor
 * that leaves it out is shown whole.
 */
export type VeraClientMessageDecision =
    | { readonly kind: "pass" }
    | { readonly kind: "handled" }
    | {
        readonly kind: "replace";
        readonly text: string;
        readonly injectedPrefix?: number;
    };

export type VeraClientMessageInterceptor = (
    message: VeraClientOutgoingMessage,
    signal: AbortSignal,
) =>
    | VeraClientMessageDecision
    | undefined
    | Promise<VeraClientMessageDecision | undefined>;
