import type { JsonValue } from "./hooks.ts";
import type { ExtensionCommandBody } from "../extensions/commands.ts";
import type {
    StatusLineSegment,
    StatusLineSnapshot,
} from "../extensions/status-line.ts";
import type { ModelReasoningEffort } from "../model/types.ts";
import type { ToolPresentation } from "../model/types.ts";
import type { PermissionInputSpec } from "../tools/types.ts";

export interface VeraExtensionApi {
    readonly config: JsonValue;
    readonly commands: VeraExtensionCommands;
    readonly tools: VeraExtensionTools;
    onDispose(dispose: VeraExtensionDisposer): void;
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
    readonly preferences: VeraClientExtensionPreferences;
    readonly modelSettings: VeraClientExtensionModelSettings;
    readonly ui: VeraClientExtensionUi;
    readonly keybindings: VeraClientExtensionKeybindings;
    readonly statusLine: VeraClientExtensionStatusLine;
    readonly messages: VeraClientExtensionMessages;
    readonly thread: VeraClientExtensionThread;
    readonly consult: VeraClientExtensionConsult;
    onDispose(dispose: VeraExtensionDisposer): void;
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
    /**
     * What the first argument names, so the client can complete it. The
     * client owns the list: `model` completes from the model pool, and
     * `mention` from the names this extension offered the composer.
     */
    readonly arguments?: "model" | "mention";
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
    notice(text: string): void;
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

export interface VeraClientExtensionKeybindings {
    register(spec: VeraClientExtensionKeybindingSpec): void;
}

export interface VeraClientExtensionKeybindingSpec {
    readonly id: string;
    readonly description: string;
    readonly keys: readonly string[];
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
}

/**
 * A second model's read on the conversation, outside the turn.
 *
 * The named model answers or the call fails. Vera never substitutes another
 * one, because an extension that asked for a specific model has no use for a
 * different model's answer. A consult runs no tools, streams nothing, and adds
 * nothing to the session.
 */
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
 */
export type VeraClientMessageDecision =
    | { readonly kind: "pass" }
    | { readonly kind: "handled" }
    | { readonly kind: "replace"; readonly text: string };

export type VeraClientMessageInterceptor = (
    message: VeraClientOutgoingMessage,
    signal: AbortSignal,
) =>
    | VeraClientMessageDecision
    | undefined
    | Promise<VeraClientMessageDecision | undefined>;
