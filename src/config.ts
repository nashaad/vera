import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dirname, isAbsolute } from "node:path";
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
import { parsePermissionModes } from "./config/permission-modes.ts";
import type { PermissionMode } from "./engine/permissions.ts";
import type { JsonValue } from "./sdk/hooks.ts";
import {
    defaultVeraExtensionDirectory,
    discoverExtensionConfigs,
    mergeExtensionConfigs,
} from "./extensions/discovery.ts";

export const VERA_CONFIG_SCHEMA_VERSION = 1;

export const VERA_PROVIDER_IDS = [
    "openrouter",
    "openai-codex",
    "ollama",
    "cerebras",
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
 * If escalation_model is configured, the fast model reviews first.
 * Decisions with high/critical risk or denials are escalated to the
 * escalation_model for final verification.
 */
export interface VeraReviewerConfig {
    readonly provider?: VeraProviderId;
    readonly model: string;
    readonly reasoning_effort?: ModelReasoningEffort;
    readonly timeout_ms?: number;
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
    readonly permission_modes?: Readonly<
        Record<string, PermissionMode>
    >;
    readonly extensions?: readonly VeraExtensionConfig[];
    readonly disabled_builtin_extensions?: readonly string[];
    readonly disabled_prompt_contributions?: readonly string[];
    readonly experimental?: VeraExperimentalConfig;
    readonly event_log?: VeraEventLogConfig;
    readonly tips?: VeraTipsConfig;
    /**
     * Where the curated model feed is fetched from. Absent means no fetch:
     * the copy shipped with the build answers instead.
     */
    readonly model_feed_url?: string;
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
}

export function defaultVeraConfigPath(): string {
    return join(homedir(), ".vera", "config.json");
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
                + " ollama, or cerebras, a non-empty model string, an optional"
                + " non-empty reasoning_effort string, optional approval_mode"
                + " ask, auto, or full_access, and optional fallback with a"
                + " different model and after_failures from 1 to 3.",
        );
    }
    const extensionDirectory = options.extensionDirectory
        ?? (options.path === undefined
            ? defaultVeraExtensionDirectory()
            : join(dirname(path), "extensions"));
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
    const modelFeedUrl = parseModelFeedUrl(config.model_feed_url);
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
        || (config.model_feed_url !== undefined && modelFeedUrl === undefined)
        || (hasModelCatalog && config.reviewer !== undefined)
        || (config.compaction !== undefined && compaction === undefined)
        ||
        config.schema_version !== VERA_CONFIG_SCHEMA_VERSION
        || (config.provider !== undefined
            && config.provider !== "openrouter"
            && config.provider !== "openai-codex"
            && config.provider !== "ollama"
            && config.provider !== "cerebras")
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
        ...(modelFeedUrl === undefined ? {} : { model_feed_url: modelFeedUrl }),
    };
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
            && reviewer.provider !== "openrouter"
            && reviewer.provider !== "openai-codex"
            && reviewer.provider !== "ollama"
            && reviewer.provider !== "cerebras")
        || (reviewer.reasoning_effort !== undefined
            && !isReasoningEffort(reviewer.reasoning_effort))
        || (reviewer.timeout_ms !== undefined
            && (typeof reviewer.timeout_ms !== "number"
                || !Number.isInteger(reviewer.timeout_ms)
                || reviewer.timeout_ms < 1_000
                || reviewer.timeout_ms > 600_000))
        || (reviewer.escalation_model !== undefined
            && (typeof reviewer.escalation_model !== "string"
                || reviewer.escalation_model.trim().length === 0))
        || (reviewer.escalation_provider !== undefined
            && reviewer.escalation_provider !== "openrouter"
            && reviewer.escalation_provider !== "openai-codex"
            && reviewer.escalation_provider !== "ollama"
            && reviewer.escalation_provider !== "cerebras")
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
        ...(reviewer.timeout_ms === undefined
            ? {}
            : { timeout_ms: reviewer.timeout_ms }),
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
            && subagent.provider !== "openrouter"
            && subagent.provider !== "openai-codex"
            && subagent.provider !== "ollama"
            && subagent.provider !== "cerebras")
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

export function configuredReviewers(
    config: VeraConfig,
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
        for (const name of Object.keys(config.reviewer_profiles)) {
            const resolved = resolveReviewerProfile(catalog, name);
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
        return configured;
    }

    const reviewer = config.reviewer;
    if (reviewer === undefined) {
        return configured;
    }
    configured.default = {
        models: [{
            model: reviewer.model,
            ...(reviewer.provider === undefined
                ? {}
                : { provider: reviewer.provider }),
            ...(reviewer.reasoning_effort === undefined
                ? {}
                : { reasoningEffort: reviewer.reasoning_effort }),
        }],
        ...(reviewer.timeout_ms === undefined
            ? {}
            : { timeoutMs: reviewer.timeout_ms }),
        ...(reviewer.escalation_model === undefined
            ? {}
            : {
                escalationModel: {
                    model: reviewer.escalation_model,
                    ...(reviewer.escalation_provider === undefined
                        ? {}
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
