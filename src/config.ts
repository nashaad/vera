import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
    builtInPermissionMode,
    parseApprovalMode,
    type ApprovalMode,
} from "./engine/permissions.ts";
import type { ModelFallbackPolicy } from "./engine/recovery.ts";
import type { ToolReviewerSettings } from "./engine/reviewer.ts";
import type { ModelReasoningEffort } from "./model/types.ts";
import {
    parseCompactionConfig,
    parseModelCatalogConfig,
    resolveCompactionProfile,
    resolveReviewerProfile,
    type ResolvedCompactionProfile,
    type VeraCatalogModel,
    type VeraCompactionConfig,
    type VeraReviewerProfileConfig,
} from "./config/model-catalog.ts";
import {
    bindModelSlot,
    describeModelSlots,
    type ModelSlotId,
    type VeraModelSlotConfig,
    type ModelSlotRow,
    parseModelSlotsConfig,
    type ReachabilityCheck,
    type VeraModelSlotsConfig,
} from "./config/model-slots.ts";
import { parsePermissionModes } from "./config/permission-modes.ts";
import type { PermissionMode } from "./engine/permissions.ts";
import type { JsonValue } from "./sdk/hooks.ts";
import {
    defaultVeraExtensionDirectory,
    discoverExtensionConfigs,
    mergeExtensionConfigs,
} from "./extensions/discovery.ts";
import { veraProfileDirectory } from "./profile-paths.ts";

export const VERA_CONFIG_SCHEMA_VERSION = 1;

export const VERA_PROVIDER_IDS = [
    "openrouter",
    "openai-codex",
    "ollama",
    "cerebras",
    "deepseek",
] as const;

export type VeraProviderId = typeof VERA_PROVIDER_IDS[number];

export function isVeraProviderId(value: string): value is VeraProviderId {
    return (VERA_PROVIDER_IDS as readonly string[]).includes(value);
}

export interface VeraModelFallbackConfig {
    readonly model: string;
    readonly after_failures: number;
}

/**
 * Model used by the automatic approval reviewer in `auto`. Every
 * boundary crossing costs one of these calls, so it is configured separately
 * from the agent model rather than inheriting it.
 *
 * If two_tier is enabled, high/critical risk allows and denials get a
 * second review. The second pass uses the same model unless escalation fields
 * override it.
 *
 * The fallback fields name a second reviewer, tried only when the first cannot
 * answer at all: it is missing, unreachable, or returns something unreadable.
 * It is not a second opinion. Without it, an unreachable reviewer leaves every
 * reviewed action with no verdict.
 */
export interface VeraReviewerConfig {
    readonly provider?: VeraProviderId;
    readonly model: string;
    readonly reasoning_effort?: ModelReasoningEffort;
    readonly fallback_model?: string;
    readonly fallback_provider?: VeraProviderId;
    readonly fallback_reasoning_effort?: ModelReasoningEffort;
    readonly timeout_ms?: number;
    readonly two_tier?: boolean;
    readonly escalation_model?: string;
    readonly escalation_provider?: VeraProviderId;
    readonly escalation_reasoning_effort?: ModelReasoningEffort;
}

/**
 * Model spawned subagents run on when the spawn names none. Configured
 * separately from the agent model because a subagent fan-out multiplies
 * whatever it inherits: a session on a frontier model should not quietly bill
 * every child at the same rate.
 */
export interface VeraSubagentConfig {
    readonly provider?: VeraProviderId;
    readonly model: string;
    readonly reasoning_effort?: ModelReasoningEffort;
}

export interface VeraExtensionConfig {
    readonly path: string;
    readonly enabled: boolean;
    readonly config: JsonValue;
}

export interface VeraTuiTranscriptConfig {
    readonly padding_left?: number;
    readonly padding_right?: number;
    readonly activity_indent?: number;
    readonly message_spacing?: number;
    readonly tool_group_spacing?: number;
    readonly separator_visible?: boolean;
    readonly separator_spacing_before?: number;
    readonly separator_spacing_after?: number;
    readonly separator_color?: string;
}

export interface VeraTuiComposerConfig {
    readonly margin_horizontal?: number;
    readonly padding_horizontal?: number;
    readonly tip_indent?: number;
    readonly boundary_color?: string;
}

/** Client-owned visual tuning. Absent values retain Vera's current layout. */
export interface VeraTuiConfig {
    readonly transcript?: VeraTuiTranscriptConfig;
    readonly composer?: VeraTuiComposerConfig;
}

export interface VeraConfig {
    readonly schema_version: typeof VERA_CONFIG_SCHEMA_VERSION;
    readonly provider: VeraProviderId;
    readonly model: string;
    readonly reasoning_effort?: ModelReasoningEffort;
    readonly approval_mode: ApprovalMode;
    readonly fallback?: VeraModelFallbackConfig;
    readonly reviewer?: VeraReviewerConfig;
    readonly subagent?: VeraSubagentConfig;
    readonly models?: readonly VeraCatalogModel[];
    readonly model_routes?: Readonly<Record<string, readonly string[]>>;
    readonly reviewer_profiles?: Readonly<
        Record<string, VeraReviewerProfileConfig>
    >;
    readonly compaction?: VeraCompactionConfig;
    /**
     * Named bindings a caller reaches for instead of naming a model. Sparse:
     * an unbound slot means the callers that wanted it do not run.
     */
    readonly model_slots?: VeraModelSlotsConfig;
    readonly permission_modes?: Readonly<
        Record<string, PermissionMode>
    >;
    readonly extensions?: readonly VeraExtensionConfig[];
    readonly disabled_builtin_extensions?: readonly string[];
    readonly disabled_prompt_contributions?: readonly string[];
    readonly experimental?: VeraExperimentalConfig;
    readonly event_log?: VeraEventLogConfig;
    readonly tips?: VeraTipsConfig;
    readonly tui?: VeraTuiConfig;
    /**
     * Where the curated model feed is fetched from. Absent means no fetch:
     * the copy shipped with the build answers instead.
     */
    readonly model_feed_url?: string;
    /**
     * How old a model may be and still be listed in the picker by default,
     * counted from when the provider first listed it. Absent means the built-in
     * cutoff. `0` disables the age rule and lists every model whatever its age.
     *
     * A picker that hides most of a provider is making a judgement call about
     * how fast the field moves, and that call is not Vera's to make on
     * everyone's behalf, so the number is a setting rather than a constant.
     */
    readonly model_picker_max_age_months?: number;
    /**
     * Fold a model out of the picker when a later version of the same model is
     * listed, so that a line of releases shows as its current version.
     *
     * Off by default. Every other reduction rule reads a fact (a submission
     * mode, an alias target, a listing date); this one reads a naming
     * convention, and a naming convention that changes hides a model someone
     * wanted. It stays opt-in until there is evidence it can be trusted on.
     */
    readonly model_picker_collapse_versions?: boolean;
}

/**
 * The tip lines the TUI shows above the composer and inside its overlays.
 *
 * On by default because tips are how the key bindings are discovered at all.
 * Absent means on.
 */
export interface VeraTipsConfig {
    readonly enabled?: boolean;
}

/**
 * The per-session jsonl event log under `~/.vera/logs`.
 *
 * On by default because `vera inspect` reads it. Absent means on.
 */
export interface VeraEventLogConfig {
    readonly enabled?: boolean;
}

/**
 * Opt-in switches for subsystems that are not finished. Absent means off, and
 * an off subsystem must not run or create state of any kind.
 */
export interface VeraExperimentalConfig {
    readonly inbox?: boolean;
}

export interface LoadVeraConfigOptions {
    readonly path?: string;
    readonly extensionDirectory?: string;
}

export interface VeraConfigDefaultsPatch {
    readonly provider?: VeraProviderId;
    readonly model?: string;
    /** `null` clears the stored default, for a model that has no effort. */
    readonly reasoning_effort?: ModelReasoningEffort | null;
    readonly approval_mode?: ApprovalMode;
    /**
     * Reviewer slots, written whole. `null` clears the reviewer entirely,
     * which returns auto mode to reviewing on the agent's own model.
     */
    readonly reviewer?: VeraReviewerConfig | null;
    /**
     * One slot, written whole. `null` unbinds it, which returns the slot to
     * inheriting its intent or, for an intent slot, to nothing at all. Only
     * the named slot is touched: the others are settings the user made
     * separately and a picker changing one must not disturb them.
     */
    readonly model_slot?: {
        readonly slot: ModelSlotId;
        readonly binding: VeraModelSlotConfig | null;
    };
}

export function defaultVeraConfigPath(): string {
    return join(veraProfileDirectory(), "config.json");
}

/**
 * A config file that exists but cannot be used. Carries the path so a client
 * can tell the user which file to fix instead of printing a stack.
 */
export class VeraConfigError extends Error {
    readonly path: string;

    constructor(path: string, problem: string) {
        super(`Vera config at ${path} could not be read: ${problem}`);
        this.name = "VeraConfigError";
        this.path = path;
    }
}

/**
 * For callers that only want the optional fields (a client reading its own
 * extension list, say). A host cannot run without a config, but a client
 * attaching to a host that is already running should not die over a file it
 * barely reads. A config that exists and is wrong is still an error: this
 * tolerates absence, not damage.
 */
export function loadOptionalVeraConfig(
    options: LoadVeraConfigOptions = {},
): VeraConfig | undefined {
    const path = options.path ?? defaultVeraConfigPath();
    if (!existsSync(path)) return undefined;
    return loadVeraConfig(options);
}

export function loadVeraConfig(
    options: LoadVeraConfigOptions = {},
): VeraConfig {
    const path = options.path ?? defaultVeraConfigPath();
    let source: string;

    try {
        source = readFileSync(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error(
                `Vera config not found at ${path}. Create it with schema_version 1, an optional provider, a model string, an optional reasoning_effort, an optional approval_mode, and an optional fallback.`,
            );
        }
        throw error;
    }

    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new VeraConfigError(path, `it is not valid JSON (${message})`);
    }

    const config = parseVeraConfig(value);
    if (config === undefined) {
        throw new VeraConfigError(
            path,
            "it is valid JSON but not a Vera config. It expected"
                + " schema_version 1, provider openrouter, openai-codex,"
                + " ollama, cerebras, or deepseek, a non-empty model string, an optional"
                + " non-empty reasoning_effort string, optional approval_mode"
                + " ask, auto, or full_access, and optional fallback with a"
                + " different model and after_failures from 1 to 3.",
        );
    }
    const extensionDirectory = options.extensionDirectory
        ?? (options.path === undefined
            ? defaultVeraExtensionDirectory()
            : join(dirname(path), "extensions"));
    const override = extensionOverrideFromEnvironment();
    if (override !== undefined) {
        return {
            ...config,
            extensions: override,
        };
    }
    const extensions = mergeExtensionConfigs(
        discoverExtensionConfigs(extensionDirectory),
        config.extensions ?? [],
    );
    if (extensions.length === 0 && config.extensions === undefined) {
        return config;
    }
    return {
        ...config,
        extensions,
    };
}

/**
 * `VERA_EXTENSIONS` replaces the whole extension list with a comma-separated
 * set of directories, so a checkout can run its own extensions without editing
 * the config. A spawned host inherits it, so client and host agree.
 */
function extensionOverrideFromEnvironment():
    | readonly VeraExtensionConfig[]
    | undefined
{
    const raw = process.env.VERA_EXTENSIONS;
    if (raw === undefined) {
        return undefined;
    }
    const paths = raw.split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    return paths.map((path) => ({
        path: resolve(path),
        enabled: true,
        config: {},
    }));
}

export function updateVeraConfigDefaults(
    patch: VeraConfigDefaultsPatch,
    options: LoadVeraConfigOptions = {},
): VeraConfig {
    const path = options.path ?? defaultVeraConfigPath();
    const current = loadVeraConfig({ path });
    const updated: VeraConfig = {
        ...current,
        ...(patch.provider === undefined ? {} : { provider: patch.provider }),
        ...(patch.model === undefined ? {} : { model: patch.model }),
        ...(patch.reasoning_effort === undefined
            ? {}
            : {
                reasoning_effort: patch.reasoning_effort === null
                    ? undefined
                    : patch.reasoning_effort,
            }),
        ...(patch.approval_mode === undefined
            ? {}
            : { approval_mode: patch.approval_mode }),
        ...(patch.reviewer === undefined
            ? {}
            : { reviewer: patch.reviewer === null ? undefined : patch.reviewer }),
        ...(patch.model_slot === undefined
            ? {}
            : { model_slots: patchedModelSlots(current.model_slots, patch.model_slot) }),
        ...(patch.provider !== undefined && patch.provider !== current.provider
            ? { fallback: undefined }
            : {}),
        ...(patch.model !== undefined && current.fallback?.model === patch.model
            ? { fallback: undefined }
            : {}),
    };
    const directory = dirname(path);
    const temporaryPath = join(directory, `.config-${randomUUID()}.tmp`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
        temporaryPath,
        `${JSON.stringify(
            { ...foreignConfigEntries(path), ...configForDisk(updated) },
            null,
            2,
        )}\n`,
        {
        mode: 0o600,
        },
    );
    renameSync(temporaryPath, path);
    return updated;
}

/**
 * Keys in `~/.vera/config.json` that belong to some other writer. `VeraConfig`
 * cannot represent them, so updating the defaults would round-trip the file
 * through a type that drops them. They are read back raw and carried across
 * instead. Nothing shares this file today; the model pool has its own.
 *
 * This is a list rather than "preserve everything unknown" on purpose. A key
 * this file no longer models is not automatically foreign; it may be one this
 * file deliberately migrated away from, and carrying those across would
 * resurrect them. Add a key here when a new owner starts writing to this file.
 */
const FOREIGN_CONFIG_KEYS: readonly string[] = [];

/**
 * One slot replaced or removed, the rest carried across untouched. Written as
 * a rebuild rather than a delete so the result stays a plain readonly record.
 */
function patchedModelSlots(
    current: VeraModelSlotsConfig | undefined,
    patch: { readonly slot: ModelSlotId; readonly binding: VeraModelSlotConfig | null },
): VeraModelSlotsConfig {
    const rest = Object.fromEntries(
        Object.entries(current ?? {}).filter(([name]) => name !== patch.slot),
    ) as VeraModelSlotsConfig;
    return patch.binding === null
        ? rest
        : { ...rest, [patch.slot]: patch.binding };
}

function foreignConfigEntries(path: string): Record<string, unknown> {
    let raw: Record<string, unknown>;
    try {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return {};
        }
        raw = value as Record<string, unknown>;
    } catch {
        return {};
    }

    return Object.fromEntries(
        FOREIGN_CONFIG_KEYS
            .filter((key) => raw[key] !== undefined)
            .map((key) => [key, raw[key]]),
    );
}

function configForDisk(config: VeraConfig): Record<string, unknown> {
    return {
        ...config,
        ...(config.permission_modes === undefined
            ? {}
            : {
                permission_modes: Object.fromEntries(
                    Object.entries(config.permission_modes).map(
                        ([name, mode]) => [
                            name,
                            {
                                default: mode.defaultOutcome,
                                ...(mode.reviewerProfile === undefined
                                    ? {}
                                    : {
                                        reviewer_profile:
                                            mode.reviewerProfile,
                                    }),
                                rules: mode.rules.map((rule) => ({
                                    when: { ...rule.when },
                                    then: rule.then,
                                })),
                            },
                        ],
                    ),
                ),
            }),
    };
}

function parseVeraConfig(value: unknown): VeraConfig | undefined {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const config = value as Record<string, unknown>;
    const fallback = parseModelFallback(config.fallback, config.model);
    const reviewer = parseReviewer(config.reviewer);
    const subagent = parseSubagentModel(config.subagent);
    const modelCatalog = parseModelCatalogConfig(
        config.models,
        config.model_routes,
        config.reviewer_profiles,
    );
    const hasModelCatalog = config.models !== undefined
        || config.model_routes !== undefined
        || config.reviewer_profiles !== undefined;
    // `permission_profiles` is a deprecated alias for `permission_modes`,
    // kept so existing configs still load. The new key wins if both are
    // present; either way the config is rewritten under the new key the
    // next time it's saved (see `configForDisk`).
    const rawPermissionModes = config.permission_modes
        ?? config.permission_profiles;
    const permissionModes = parsePermissionModes(
        rawPermissionModes,
        modelCatalog?.reviewer_profiles ?? {},
    );
    // Routes come from the catalog, so a compaction block without one has
    // nothing to name and is rejected rather than half-resolved.
    const compaction = config.compaction === undefined
        ? undefined
        : parseCompactionConfig(
            config.compaction,
            modelCatalog?.model_routes ?? {},
        );
    // Slots name routes, so they parse against the same catalog compaction
    // does, and a slot naming a route the catalog dropped rejects the block
    // rather than binding a caller to a short list.
    const modelSlots = parseModelSlotsConfig(
        config.model_slots,
        modelCatalog?.model_routes ?? {},
    );
    const extensions = parseExtensionConfigs(config.extensions);
    const disabledBuiltinExtensions = parseStringList(
        config.disabled_builtin_extensions,
    );
    const disabledPromptContributions = parseStringList(
        config.disabled_prompt_contributions,
    );
    const experimental = parseExperimental(config.experimental);
    const eventLog = parseEventLog(config.event_log);
    const tips = parseEventLog(config.tips);
    const tui = parseTuiConfig(config.tui);
    const modelFeedUrl = parseModelFeedUrl(config.model_feed_url);
    const maxAgeMonths = parseMaxAgeMonths(config.model_picker_max_age_months);
    const collapseVersions = config.model_picker_collapse_versions;
    const approvalMode = config.approval_mode === undefined
        ? "auto"
        : parseApprovalMode(config.approval_mode);
    const hasSelectedMode = approvalMode !== undefined
        && (
            builtInPermissionMode(approvalMode) !== undefined
            || permissionModes?.[approvalMode] !== undefined
        );
    if (
        (config.reviewer !== undefined && reviewer === undefined)
        || (config.subagent !== undefined && subagent === undefined)
        || modelCatalog === undefined
        || permissionModes === undefined
        || extensions === undefined
        || disabledBuiltinExtensions === undefined
        || disabledPromptContributions === undefined
        || experimental === undefined
        || eventLog === undefined
        || tui === undefined
        || (config.model_feed_url !== undefined && modelFeedUrl === undefined)
        || (config.model_picker_max_age_months !== undefined
            && maxAgeMonths === undefined)
        || (collapseVersions !== undefined
            && typeof collapseVersions !== "boolean")
        || (config.compaction !== undefined && compaction === undefined)
        || modelSlots === undefined
        ||
        config.schema_version !== VERA_CONFIG_SCHEMA_VERSION
        || (config.provider !== undefined
            && (typeof config.provider !== "string"
                || !isVeraProviderId(config.provider)))
        || typeof config.model !== "string"
        || config.model.trim().length === 0
        || (config.reasoning_effort !== undefined
            && !isReasoningEffort(config.reasoning_effort))
        || !hasSelectedMode
        || (config.fallback !== undefined && fallback === undefined)
    ) {
        return undefined;
    }

    return {
        schema_version: VERA_CONFIG_SCHEMA_VERSION,
        provider: config.provider ?? "openrouter",
        model: config.model.trim(),
        approval_mode: approvalMode,
        ...(config.reasoning_effort === undefined
            ? {}
            : { reasoning_effort: config.reasoning_effort }),
        ...(fallback === undefined ? {} : { fallback }),
        ...(reviewer === undefined ? {} : { reviewer }),
        ...(subagent === undefined ? {} : { subagent }),
        ...(hasModelCatalog
            ? {
                models: modelCatalog.models,
                model_routes: modelCatalog.model_routes,
                reviewer_profiles: modelCatalog.reviewer_profiles,
            }
            : {}),
        ...(compaction === undefined ? {} : { compaction }),
        ...(modelSlots === undefined || Object.keys(modelSlots).length === 0
            ? {}
            : { model_slots: modelSlots }),
        ...(rawPermissionModes === undefined
            ? {}
            : { permission_modes: permissionModes }),
        ...(config.extensions === undefined ? {} : { extensions }),
        ...(config.disabled_builtin_extensions === undefined
            ? {}
            : {
                disabled_builtin_extensions: disabledBuiltinExtensions,
            }),
        ...(config.disabled_prompt_contributions === undefined
            ? {}
            : {
                disabled_prompt_contributions: disabledPromptContributions,
            }),
        ...(config.experimental === undefined ? {} : { experimental }),
        ...(config.event_log === undefined ? {} : { event_log: eventLog }),
        ...(config.tips === undefined ? {} : { tips }),
        ...(config.tui === undefined ? {} : { tui }),
        ...(modelFeedUrl === undefined ? {} : { model_feed_url: modelFeedUrl }),
        ...(maxAgeMonths === undefined
            ? {}
            : { model_picker_max_age_months: maxAgeMonths }),
        ...(typeof collapseVersions === "boolean"
            ? { model_picker_collapse_versions: collapseVersions }
            : {}),
    };
}

function parseTuiConfig(value: unknown): VeraTuiConfig | undefined {
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const raw = value as Record<string, unknown>;
    const transcript = parseTuiTranscriptConfig(raw.transcript);
    const composer = parseTuiComposerConfig(raw.composer);
    if (transcript === undefined || composer === undefined) {
        return undefined;
    }
    return {
        ...(raw.transcript === undefined ? {} : { transcript }),
        ...(raw.composer === undefined ? {} : { composer }),
    };
}

function parseTuiTranscriptConfig(
    value: unknown,
): VeraTuiTranscriptConfig | undefined {
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const raw = value as Record<string, unknown>;
    if (
        !isOptionalLayoutCount(raw.padding_left, 0, 20)
        || !isOptionalLayoutCount(raw.padding_right, 0, 20)
        || !isOptionalLayoutCount(raw.activity_indent, 1, 12)
        || !isOptionalLayoutCount(raw.message_spacing, 0, 5)
        || !isOptionalLayoutCount(raw.tool_group_spacing, 0, 5)
        || (raw.separator_visible !== undefined
            && typeof raw.separator_visible !== "boolean")
        || !isOptionalLayoutCount(raw.separator_spacing_before, 0, 5)
        || !isOptionalLayoutCount(raw.separator_spacing_after, 0, 5)
        || !isOptionalHexColor(raw.separator_color)
    ) {
        return undefined;
    }
    return {
        ...(raw.padding_left === undefined
            ? {}
            : { padding_left: raw.padding_left as number }),
        ...(raw.padding_right === undefined
            ? {}
            : { padding_right: raw.padding_right as number }),
        ...(raw.activity_indent === undefined
            ? {}
            : { activity_indent: raw.activity_indent as number }),
        ...(raw.message_spacing === undefined
            ? {}
            : { message_spacing: raw.message_spacing as number }),
        ...(raw.tool_group_spacing === undefined
            ? {}
            : { tool_group_spacing: raw.tool_group_spacing as number }),
        ...(raw.separator_visible === undefined
            ? {}
            : { separator_visible: raw.separator_visible as boolean }),
        ...(raw.separator_spacing_before === undefined
            ? {}
            : {
                separator_spacing_before:
                    raw.separator_spacing_before as number,
            }),
        ...(raw.separator_spacing_after === undefined
            ? {}
            : {
                separator_spacing_after:
                    raw.separator_spacing_after as number,
            }),
        ...(raw.separator_color === undefined
            ? {}
            : { separator_color: raw.separator_color as string }),
    };
}

function parseTuiComposerConfig(
    value: unknown,
): VeraTuiComposerConfig | undefined {
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const raw = value as Record<string, unknown>;
    if (
        !isOptionalLayoutCount(raw.margin_horizontal, 0, 20)
        || !isOptionalLayoutCount(raw.padding_horizontal, 0, 12)
        || !isOptionalLayoutCount(raw.tip_indent, 0, 24)
        || !isOptionalHexColor(raw.boundary_color)
    ) {
        return undefined;
    }
    return {
        ...(raw.margin_horizontal === undefined
            ? {}
            : { margin_horizontal: raw.margin_horizontal as number }),
        ...(raw.padding_horizontal === undefined
            ? {}
            : { padding_horizontal: raw.padding_horizontal as number }),
        ...(raw.tip_indent === undefined
            ? {}
            : { tip_indent: raw.tip_indent as number }),
        ...(raw.boundary_color === undefined
            ? {}
            : { boundary_color: raw.boundary_color as string }),
    };
}

function isOptionalLayoutCount(
    value: unknown,
    minimum: number,
    maximum: number,
): boolean {
    return value === undefined
        || (typeof value === "number"
            && Number.isInteger(value)
            && value >= minimum
            && value <= maximum);
}

function isOptionalHexColor(value: unknown): boolean {
    return value === undefined
        || (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value));
}

/**
 * Only `http` and `https` are accepted. Every other scheme reaches a different
 * subsystem with the same call, and the feed is a network fetch.
 */
function parseModelFeedUrl(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        return undefined;
    }
    return parsed.protocol === "http:" || parsed.protocol === "https:"
        ? trimmed
        : undefined;
}

function parseMaxAgeMonths(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
}

function parseExperimental(
    value: unknown,
): VeraExperimentalConfig | undefined {
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const raw = value as Record<string, unknown>;
    if (raw.inbox !== undefined && typeof raw.inbox !== "boolean") {
        return undefined;
    }
    return raw.inbox === undefined ? {} : { inbox: raw.inbox };
}

function parseEventLog(value: unknown): VeraEventLogConfig | undefined {
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const raw = value as Record<string, unknown>;
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
        return undefined;
    }
    return raw.enabled === undefined ? {} : { enabled: raw.enabled };
}

/** Absent config, absent block, and absent key all mean on. */
export function eventLogEnabled(config: VeraConfig): boolean {
    return config.event_log?.enabled !== false;
}

/** Absent config, absent block, and absent key all mean on. */
export function tipsEnabled(config: Pick<VeraConfig, "tips">): boolean {
    return config.tips?.enabled !== false;
}

function parseStringList(value: unknown): readonly string[] | undefined {
    if (value === undefined) {
        return [];
    }
    if (
        !Array.isArray(value)
        || !value.every((item) =>
            typeof item === "string" && item.trim().length > 0
        )
    ) {
        return undefined;
    }
    const normalized = value.map((item) => item.trim());
    return new Set(normalized).size === normalized.length
        ? normalized
        : undefined;
}

function parseExtensionConfigs(
    value: unknown,
): readonly VeraExtensionConfig[] | undefined {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        return undefined;
    }

    const extensions: VeraExtensionConfig[] = [];
    for (const item of value) {
        if (
            typeof item !== "object"
            || item === null
            || Array.isArray(item)
        ) {
            return undefined;
        }
        const extension = item as Record<string, unknown>;
        if (
            typeof extension.path !== "string"
            || extension.path.trim().length === 0
            || !isAbsolute(extension.path.trim())
            || (extension.enabled !== undefined
                && typeof extension.enabled !== "boolean")
            || (extension.config !== undefined
                && !isJsonValue(extension.config))
        ) {
            return undefined;
        }
        extensions.push({
            path: extension.path.trim(),
            enabled: extension.enabled ?? true,
            config: extension.config === undefined ? {} : extension.config,
        });
    }
    return extensions;
}

function isJsonValue(value: unknown): value is JsonValue {
    if (
        value === null
        || typeof value === "string"
        || typeof value === "boolean"
    ) {
        return true;
    }
    if (typeof value === "number") {
        return Number.isFinite(value);
    }
    if (Array.isArray(value)) {
        return value.every(isJsonValue);
    }
    if (typeof value !== "object") {
        return false;
    }
    return Object.values(value).every(isJsonValue);
}

function parseReviewer(value: unknown): VeraReviewerConfig | undefined {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }
    const reviewer = value as Record<string, unknown>;
    if (
        typeof reviewer.model !== "string"
        || reviewer.model.trim().length === 0
        || (reviewer.provider !== undefined
            && (typeof reviewer.provider !== "string"
                || !isVeraProviderId(reviewer.provider)))
        || (reviewer.reasoning_effort !== undefined
            && !isReasoningEffort(reviewer.reasoning_effort))
        || (reviewer.fallback_model !== undefined
            && (typeof reviewer.fallback_model !== "string"
                || reviewer.fallback_model.trim().length === 0))
        || (reviewer.fallback_provider !== undefined
            && (typeof reviewer.fallback_provider !== "string"
                || !isVeraProviderId(reviewer.fallback_provider)))
        || (reviewer.fallback_reasoning_effort !== undefined
            && !isReasoningEffort(reviewer.fallback_reasoning_effort))
        || (reviewer.timeout_ms !== undefined
            && (typeof reviewer.timeout_ms !== "number"
                || !Number.isInteger(reviewer.timeout_ms)
                || reviewer.timeout_ms < 1_000
                || reviewer.timeout_ms > 600_000))
        || (reviewer.two_tier !== undefined
            && typeof reviewer.two_tier !== "boolean")
        || (reviewer.escalation_model !== undefined
            && (typeof reviewer.escalation_model !== "string"
                || reviewer.escalation_model.trim().length === 0))
        || (reviewer.escalation_provider !== undefined
            && (typeof reviewer.escalation_provider !== "string"
                || !isVeraProviderId(reviewer.escalation_provider)))
        || (reviewer.escalation_reasoning_effort !== undefined
            && !isReasoningEffort(reviewer.escalation_reasoning_effort))
    ) {
        return undefined;
    }
    return {
        model: reviewer.model.trim(),
        ...(reviewer.provider === undefined
            ? {}
            : { provider: reviewer.provider as VeraProviderId }),
        ...(reviewer.reasoning_effort === undefined
            ? {}
            : { reasoning_effort: reviewer.reasoning_effort }),
        ...(reviewer.fallback_model === undefined
            ? {}
            : { fallback_model: reviewer.fallback_model.trim() }),
        ...(reviewer.fallback_provider === undefined
            ? {}
            : { fallback_provider: reviewer.fallback_provider as VeraProviderId }),
        ...(reviewer.fallback_reasoning_effort === undefined
            ? {}
            : { fallback_reasoning_effort: reviewer.fallback_reasoning_effort }),
        ...(reviewer.timeout_ms === undefined
            ? {}
            : { timeout_ms: reviewer.timeout_ms }),
        ...(reviewer.two_tier === undefined
            ? {}
            : { two_tier: reviewer.two_tier }),
        ...(reviewer.escalation_model === undefined
            ? {}
            : { escalation_model: reviewer.escalation_model.trim() }),
        ...(reviewer.escalation_provider === undefined
            ? {}
            : { escalation_provider: reviewer.escalation_provider as VeraProviderId }),
        ...(reviewer.escalation_reasoning_effort === undefined
            ? {}
            : { escalation_reasoning_effort: reviewer.escalation_reasoning_effort }),
    };
}

function parseSubagentModel(value: unknown): VeraSubagentConfig | undefined {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }
    const subagent = value as Record<string, unknown>;
    if (
        typeof subagent.model !== "string"
        || subagent.model.trim().length === 0
        || (subagent.provider !== undefined
            && (typeof subagent.provider !== "string"
                || !isVeraProviderId(subagent.provider)))
        || (subagent.reasoning_effort !== undefined
            && !isReasoningEffort(subagent.reasoning_effort))
    ) {
        return undefined;
    }
    return {
        model: subagent.model.trim(),
        ...(subagent.provider === undefined
            ? {}
            : { provider: subagent.provider as VeraProviderId }),
        ...(subagent.reasoning_effort === undefined
            ? {}
            : { reasoning_effort: subagent.reasoning_effort }),
    };
}

function isReasoningEffort(value: unknown): value is ModelReasoningEffort {
    return typeof value === "string" && value.length > 0;
}

/**
 * The configured subagent default in engine terms, or undefined to leave
 * spawns inheriting the parent model.
 */
export function configuredSubagentModel(
    config: VeraConfig,
): { provider?: string; model: string; reasoningEffort?: ModelReasoningEffort } | undefined {
    if (config.subagent === undefined) {
        return undefined;
    }
    return {
        model: config.subagent.model,
        ...(config.subagent.provider === undefined
            ? {}
            : { provider: config.subagent.provider }),
        ...(config.subagent.reasoning_effort === undefined
            ? {}
            : { reasoningEffort: config.subagent.reasoning_effort }),
    };
}

/**
 * Maps the reviewer block onto engine settings. Returns `undefined` when no
 * reviewer is configured, which leaves the reviewer on the agent's own model.
 */
export function configuredReviewer(
    config: VeraConfig,
): ToolReviewerSettings | undefined {
    return configuredReviewers(config).default;
}

/**
 * The compaction profile with every declared slot bound to catalog entries, or
 * undefined when compaction is unconfigured or names something the catalog no
 * longer has. Undefined means the session simply does not compact: a broken
 * route must not be resolved into a shorter one and used anyway.
 */
export function configuredCompaction(
    config: VeraConfig,
): ResolvedCompactionProfile | undefined {
    if (
        config.compaction === undefined
        || config.models === undefined
        || config.model_routes === undefined
    ) {
        return undefined;
    }
    return resolveCompactionProfile({
        models: config.models,
        model_routes: config.model_routes,
        reviewer_profiles: config.reviewer_profiles ?? {},
    }, config.compaction);
}

/**
 * `isReachable` comes from the pool. Without it a route is judged on whether
 * its models are declared, which is a weaker question than whether they can be
 * used, so callers that have the pool should pass it.
 */
/**
 * What a compaction strategy slot takes when the profile names no route for
 * it. Empty when nothing is bound, which leaves the session's own model as the
 * answer, since a session that fills its window has to compact regardless.
 */
export function configuredCompactionModels(
    config: VeraConfig,
    isReachable?: ReachabilityCheck,
): readonly VeraCatalogModel[] {
    if (config.models === undefined || config.model_routes === undefined) {
        return [];
    }
    return bindModelSlot(
        {
            models: config.models,
            model_routes: config.model_routes,
            reviewer_profiles: config.reviewer_profiles ?? {},
        },
        config.model_slots ?? {},
        { slot: "compaction", demand: "required" },
        isReachable,
    ).models;
}

/**
 * Every slot as it stands, for a surface that lists them. Empty when no
 * catalog is configured, since there is nothing a slot could name.
 */
export function configuredModelSlots(
    config: VeraConfig,
    isReachable?: ReachabilityCheck,
): readonly ModelSlotRow[] {
    if (config.models === undefined || config.model_routes === undefined) {
        return [];
    }
    return describeModelSlots(
        {
            models: config.models,
            model_routes: config.model_routes,
            reviewer_profiles: config.reviewer_profiles ?? {},
        },
        config.model_slots ?? {},
        isReachable,
    );
}

export function configuredReviewers(
    config: VeraConfig,
    isReachable?: ReachabilityCheck,
): Readonly<Record<string, ToolReviewerSettings>> {
    const configured: Record<string, ToolReviewerSettings> = {};
    if (
        config.models !== undefined
        && config.model_routes !== undefined
        && config.reviewer_profiles !== undefined
    ) {
        const catalog = {
            models: config.models,
            model_routes: config.model_routes,
            reviewer_profiles: config.reviewer_profiles,
        };
        const slot = bindModelSlot(
            catalog,
            config.model_slots ?? {},
            { slot: "reviewer", demand: "optional" },
            isReachable,
        );
        for (const name of Object.keys(config.reviewer_profiles)) {
            const resolved = resolveReviewerProfile(catalog, name, slot.models);
            if (resolved === undefined) {
                continue;
            }
            configured[name] = {
                models: resolved.models.map((model) => ({
                    provider: model.provider,
                    model: model.model,
                    ...(model.reasoning_effort === undefined
                        ? {}
                        : { reasoningEffort: model.reasoning_effort }),
                })),
                policy: resolved.policy,
                ...(resolved.timeout_ms === undefined
                    ? {}
                    : { timeoutMs: resolved.timeout_ms }),
            };
        }
    }

    const reviewer = config.reviewer;
    // A catalog names reviewers; the plain block names the default one. A
    // profile actually called `default` wins, since it was written by hand.
    if (reviewer === undefined || configured.default !== undefined) {
        return configured;
    }
    const escalationConfigured = reviewer.escalation_model !== undefined
        || reviewer.escalation_provider !== undefined
        || reviewer.escalation_reasoning_effort !== undefined;
    configured.default = {
        // Ordered route: the router walks it and moves on when a reviewer
        // cannot answer, so the fallback is simply the second entry.
        models: [
            {
                model: reviewer.model,
                ...(reviewer.provider === undefined
                    ? {}
                    : { provider: reviewer.provider }),
                ...(reviewer.reasoning_effort === undefined
                    ? {}
                    : { reasoningEffort: reviewer.reasoning_effort }),
            },
            ...(reviewer.fallback_model === undefined ? [] : [{
                model: reviewer.fallback_model,
                ...(reviewer.fallback_provider === undefined
                    ? reviewer.provider === undefined
                        ? {}
                        : { provider: reviewer.provider }
                    : { provider: reviewer.fallback_provider }),
                ...(reviewer.fallback_reasoning_effort === undefined
                    ? {}
                    : { reasoningEffort: reviewer.fallback_reasoning_effort }),
            }]),
        ],
        ...(reviewer.timeout_ms === undefined
            ? {}
            : { timeoutMs: reviewer.timeout_ms }),
        ...(reviewer.two_tier === undefined
            ? {}
            : { twoTier: reviewer.two_tier }),
        ...(!escalationConfigured
            ? {}
            : {
                escalationModel: {
                    model: reviewer.escalation_model ?? reviewer.model,
                    ...(reviewer.escalation_provider === undefined
                        ? reviewer.provider === undefined
                            ? {}
                            : { provider: reviewer.provider }
                        : { provider: reviewer.escalation_provider }),
                    ...(reviewer.escalation_reasoning_effort === undefined
                        ? {}
                        : {
                            reasoningEffort:
                                reviewer.escalation_reasoning_effort,
                        }),
                },
            }),
    };
    return configured;
}

export function configuredModelFallback(
    config: VeraConfig,
): ModelFallbackPolicy | undefined {
    if (config.fallback === undefined) {
        return undefined;
    }
    return {
        provider: config.provider,
        model: config.fallback.model,
        afterFailures: config.fallback.after_failures,
    };
}

function parseModelFallback(
    value: unknown,
    primaryModel: unknown,
): VeraModelFallbackConfig | undefined {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }
    const fallback = value as Record<string, unknown>;
    if (
        typeof fallback.model !== "string"
        || fallback.model.trim().length === 0
        || typeof fallback.after_failures !== "number"
        || !Number.isInteger(fallback.after_failures)
        || fallback.after_failures < 1
        || fallback.after_failures > 3
        || (typeof primaryModel === "string"
            && fallback.model.trim() === primaryModel.trim())
    ) {
        return undefined;
    }
    return {
        model: fallback.model.trim(),
        after_failures: fallback.after_failures,
    };
}
