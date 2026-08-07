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
