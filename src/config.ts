import { isVeraProviderId } from "./providers/builtin-id.ts";
export { isVeraProviderId } from "./providers/builtin-id.ts";
import { fileReadStamp } from "./store/read-cache.ts";
import { eligibleForDefault } from "./model/model-operations.ts";
import { loadPoolFile as loadAssignmentPool } from "./model/pool-file-loader.ts";
import {
    existsSync,
    mkdirSync,
    renameSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { readRegularFileTextSync } from "./store/regular-file.ts";

import {
    parseApprovalMode,
    type ApprovalMode,
} from "./sdk/permissions.ts";
import { isBuiltInPermissionMode } from "./sdk/permissions.ts";
import type { ToolResultLimits } from "./engine/tool-result-history.ts";
import { TOOL_RESULT_CEILING_BYTES } from "./tools/tool-result-limit.ts";
import type { CompactionOverrides } from "./engine/compaction-binding.ts";
import { validatePromptContributionOrder } from "./engine/prompt-contributions.ts";
import {
    OVERRIDE_KEYS,
    type ConfiguredOverrides,
    type OverrideKey,
} from "./engine/override-keys.ts";
import type { OverrideSettingsPatch } from "./engine/model-settings.ts";
import type { ModelFallbackPolicy } from "./engine/recovery.ts";
import type { ToolReviewerSettings } from "./engine/reviewer.ts";
import type { ModelReasoningEffort } from "./model/types.ts";
import type { CacheRetention } from "./model/prompt-cache.ts";
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
    bindModelAssignment,
    describeModelAssignments,
    type ModelAssignmentId,
    type VeraModelAssignmentConfig,
    type ModelAssignmentRow,
    parseModelAssignmentsConfig,
    type ReachabilityCheck,
    type VeraModelAssignmentsConfig,
} from "./config/model-assignments.ts";
import { parsePermissionModes } from "./config/permission-modes.ts";
import {
    collectConfigProblem,
    configProblem,
    describeConfigProblem,
    expectedValue,
    isPlainObject,
    keyValue,
    type ConfigFieldProblem,
} from "./config/diagnostic.ts";
import type { PermissionMode } from "./engine/permissions.ts";
import type { JsonValue } from "./sdk/hooks.ts";
import { commandHookPhase, type CommandHookSpec } from "./extensions/command-hook.ts";
import {
    defaultVeraExtensionDirectory,
    discoverExtensionConfigs,
    discoverManagedExtensionConfigs,
    mergeExtensionConfigs,
} from "./extensions/discovery.ts";
import { selectedVeraHome, veraProfileDirectory } from "./profile-paths.ts";
import {
    isFixedEndpointProvider,
    parseCache,
    providerDefinition,
    shippedProviderIds,
    type ProviderCacheDefinition,
} from "./providers/definitions.ts";
import { isUserProviderUrl } from "./providers/endpoint-url.ts";
import { isSafeProviderId } from "./providers/provider-id.ts";
import {
    parseModelReference,
    parseModelRequestOptions,
    validateProviderRequestBody,
    type VeraModelRequestOptions,
} from "./providers/request-options.ts";

export const VERA_CONFIG_SCHEMA_VERSION = 1;

/** Compatibility export while callers move to the provider resolver. */
export const VERA_PROVIDER_IDS: readonly string[] = shippedProviderIds();

export type VeraBuiltInProviderId = typeof VERA_PROVIDER_IDS[number];

/**
 * A provider reference is either one of Vera's built-ins or a named endpoint
 * declared in `providers`. It stays a string at the model boundary because
 * user-owned instance names cannot be represented by a closed union.
 */
export type VeraProviderId = string;


export type VeraProviderProtocol = "openai-chat" | "anthropic-messages";
export type VeraProviderCredential = "api_key" | "none";
export type VeraAnthropicThinkingMode = "adaptive";

export interface VeraCustomProviderConfig {
    readonly protocol: VeraProviderProtocol;
    readonly base_url: string;
    readonly credential: VeraProviderCredential;
    readonly api_key_env?: string;
    readonly images?: boolean;
    readonly max_tokens?: number;
    /** Opts an Anthropic-compatible endpoint into the current thinking API. */
    readonly thinking?: VeraAnthropicThinkingMode;
    /** Replaces the cache behavior the protocol implies. */
    readonly cache?: ProviderCacheDefinition;
}

export interface VeraModelFallbackConfig {
    readonly model: string;
    readonly after_failures: number;
}

/**
 * How the classifier reviews. Which models it uses is the `reviewer` model
 * assignment; this block never names them.
 *
 * If two_tier is enabled, high/critical risk allows and denials get a
 * second review. The second pass uses the assigned primary unless escalation
 * fields override it.
 */
export interface VeraReviewerConfig {
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

export interface VeraTuiDialogsConfig {
    readonly header_style?: "underline" | "box";
    readonly search_style?: "border" | "fill" | "plain";
}

export interface VeraTuiSidebarConfig {
    readonly open_at_launch?: boolean;
}

/** Client-owned visual tuning. Absent values retain Vera's current layout. */
export interface VeraTuiConfig {
    readonly assistant_marker?: "●" | "•" | "";
    readonly transcript?: VeraTuiTranscriptConfig;
    readonly composer?: VeraTuiComposerConfig;
    readonly dialogs?: VeraTuiDialogsConfig;
    readonly sidebar?: VeraTuiSidebarConfig;
}

/**
 * An executable hook the user wires up without writing an extension. `argv[0]`
 * names a file inside the profile's `hooks/` directory and is stored resolved
 * to an absolute path; nothing outside that directory can be reached, so a
 * config that travels between machines cannot point at an arbitrary binary.
 */
export interface VeraHookConfig {
    readonly phase: CommandHookSpec["phase"];
    readonly argv: readonly string[];
    readonly protocol?: "vera" | "claude";
    readonly timeout_ms?: number;
}

export interface VeraHostConfig {
    readonly workers?: number;
}

export interface VeraConfig {
    readonly schema_version: typeof VERA_CONFIG_SCHEMA_VERSION;
    readonly host?: VeraHostConfig;
    readonly provider: VeraProviderId;
    /** Named instances of standard model-provider wire protocols. */
    readonly providers?: Readonly<Record<string, VeraCustomProviderConfig>>;
    /**
     * The endpoint to use for a provider Vera ships, in place of the one it
     * ships with. A region, a proxy, or a gateway is the same provider on a
     * different host, so the host is the user's to set.
     */
    readonly provider_endpoints?: Readonly<Record<string, string>>;
    readonly model: string;
    readonly model_request_options?: VeraModelRequestOptions;
    readonly reasoning_effort?: ModelReasoningEffort;
    /** Global ceiling applied to every model's declared context window. */
    readonly context_limit?: number;
    /**
     * Fractions of the context window at which the context size trigger hook
     * fires as context grows past them. Sorted ascending when loaded.
     */
    readonly context_size_events?: readonly number[];
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
     * an unbound assignment means the callers that wanted it do not run.
     */
    readonly model_assignments?: VeraModelAssignmentsConfig;
    readonly permission_modes?: Readonly<
        Record<string, PermissionMode>
    >;
    readonly extensions?: readonly VeraExtensionConfig[];
    readonly hooks?: readonly VeraHookConfig[];
    readonly disabled_included_extensions?: readonly string[];
    // Skill names; a trailing `*` matches a prefix, so `["*"]` turns skills off.
    readonly disabled_skills?: readonly string[];
    readonly disabled_prompt_contributions?: readonly string[];
    /**
     * Which pieces of the system prompt render, and in what order. Absent
     * uses the order the build ships. Every piece must be named exactly once;
     * to drop one, list it in `disabled_prompt_contributions` as well.
     */
    readonly prompt_contribution_order?: readonly string[];
    readonly experimental?: VeraExperimentalConfig;
    readonly tool_results?: VeraToolResultsConfig;
    readonly prompt_cache?: VeraPromptCacheConfig;
    readonly event_log?: VeraEventLogConfig;
    readonly tips?: VeraTipsConfig;
    readonly tui?: VeraTuiConfig;
    /**
     * Where the curated model feed is fetched from. Absent means no fetch:
     * the copy shipped with the build answers instead.
     */
    readonly model_feed_url?: string;
    /**
     * Where the curated model list is fetched from. Absent uses the shipped
     * address; an empty string turns the fetch off and leaves the picks to
     * the recommendations shipped with the build.
     */
    readonly curated_models_url?: string;
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
    /** Probe a model before it is newly assigned as a default. Off when absent. */
    readonly verify_model_assignments?: boolean;
    /**
     * How many days a discovered model list answers for before the provider is
     * asked again. Absent means the built-in week. `0` asks on every start,
     * which is what Vera used to do unconditionally.
     *
     * Starting Vera is not a reason to call a provider: the lists change over
     * weeks, and the call was paid on every launch. `vera models refresh`
     * fetches now whatever this says.
     */
    readonly model_catalog_max_age_days?: number;
    /** Whole days a file under `runtime/logs/` is kept. Absent means the built-in week. */
    readonly log_max_age_days?: number;
    /** Source families this user has allowed to start delivery turns. */
    readonly inbox?: VeraInboxConfig;
}

export interface VeraInboxConfig {
    readonly admit?: readonly string[];
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
    readonly outrider_onboarding?: boolean;
}

/**
 * Which row of the aging ladder a session uses. `auto` picks the row from the
 * resolved context window, which is what a session does when nothing is set.
 */
export type VeraToolResultAgingLevel =
    | "auto"
    | "relaxed"
    | "normal"
    | "tight";

export const VERA_TOOL_RESULT_AGING_LEVELS: readonly VeraToolResultAgingLevel[] =
    ["auto", "relaxed", "normal", "tight"];

/**
 * How much of a turn's context tool results are allowed to occupy. A single
 * result large enough to fill a small window is the failure these bound, so
 * the byte ceilings matter most on the smallest models.
 */
export interface VeraToolResultsConfig {
    /** Bytes of one result kept before head and tail truncation. */
    readonly ceiling_bytes?: number;
    /** Bytes of every result combined in one request. */
    readonly total_budget_bytes?: number;
    /** Turns a result stays whole before it can be stubbed. `0` stubs at once. */
    readonly stub_after_turns?: number;
    /** Pins a row of the aging ladder instead of choosing one by window. */
    readonly aging_level?: VeraToolResultAgingLevel;
}

export interface VeraPromptCacheConfig {
    /** Absent asks providers for their default cache lifetime. */
    readonly retention?: CacheRetention;
}

export interface LoadVeraConfigOptions {
    readonly path?: string;
    readonly extensionDirectory?: string;
}

let workerConfigReadOnly = false;

export function forbidWorkerConfigWrites(): void {
    workerConfigReadOnly = true;
}

function requireWritableConfig(): void {
    if (workerConfigReadOnly) throw new Error("Worker configuration is read only");
}

export interface VeraConfigDefaultsPatch {
    readonly provider?: VeraProviderId;
    /** Adds the id to `disabled_included_extensions`, or takes it off. */
    readonly included_extension?: {
        readonly id: string;
        readonly enabled: boolean;
    };
    readonly model?: string;
    /** Replaces or removes one exact provider/model request body. */
    readonly model_request_options?: {
        readonly model: string;
        readonly body: Readonly<Record<string, JsonValue>> | null;
    };
    /** `null` clears the stored default, for a model that has no effort. */
    readonly reasoning_effort?: ModelReasoningEffort | null;
    /** `null` returns context sizing to the model's declared maximum. */
    readonly context_limit?: number | null;
    readonly approval_mode?: ApprovalMode;
    /** Review settings, written whole. `null` removes them. */
    readonly reviewer?: VeraReviewerConfig | null;
    /**
     * One assignment, written whole. `null` unbinds it, which returns it to
     * inheriting its intent or, for an intent row, to nothing at all. Only
     * the named one is touched: the others are settings the user made
     * separately and a picker changing one must not disturb them.
     */
    readonly model_assignment?: {
        readonly assignment: ModelAssignmentId;
        readonly binding: VeraModelAssignmentConfig | null;
    };
    /**
     * One declared provider, written whole. `null` removes it. Only the named
     * one is touched: the others are endpoints the user declared separately.
     * The declaration is validated by the same parsing the loader applies to
     * the `providers` block, so a written entry and a hand-written entry
     * cannot diverge.
     */
    readonly custom_provider?: {
        readonly id: string;
        readonly declaration: VeraCustomProviderConfig | null;
    };
    /**
     * One shipped provider's endpoint, written whole. `null` restores the one
     * Vera ships with. Only the named one is touched.
     */
    readonly provider_endpoint?: {
        readonly id: string;
        readonly url: string | null;
    };
    readonly inbox?: VeraInboxConfig | null;
    /**
     * Tool result limits, merged field by field. A field set to `null` clears
     * that field alone.
     */
    readonly tool_results?: Readonly<
        Record<string, number | string | null | undefined>
    >;
    /**
     * Compaction numbers, merged field by field. A field set to `null` clears
     * that field alone. The strategy and its routes are left as they stand:
     * a pane that retunes a number must not unbind the models compaction runs
     * on.
     */
    readonly compaction?: Readonly<Record<string, number | null | undefined>>;
}

export function defaultVeraConfigPath(home?: string): string {
    return join(selectedVeraHome(home), "config.json");
}

/**
 * A config file that exists but cannot be used. Carries the path so a client
 * can tell the user which file to fix instead of printing a stack.
 */
export class VeraConfigError extends Error {
    readonly path: string;
    readonly problem: string;
    /**
     * Path to the field the parser refused, such as `extensions[5]`, when it
     * named one. The startup recovery prompt removes this field.
     */
    readonly field: string | undefined;
    /** What was wrong with `field`, without the sentence around it; `problem` when the parser gave none. */
    readonly reason: string;

    constructor(path: string, problem: string, field?: string, reason?: string) {
        super(`Vera config at ${path} could not be read: ${problem}`);
        this.name = "VeraConfigError";
        this.path = path;
        this.problem = problem;
        this.field = field;
        this.reason = reason ?? problem;
    }
}

/** A write refused because the file it would leave could not be loaded back. */
export class VeraConfigWriteError extends Error {
    readonly path: string;

    constructor(path: string, problem: string) {
        super(`Vera config at ${path} was not written: ${problem}`);
        this.name = "VeraConfigWriteError";
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

export interface LastGoodVeraConfig {
    readonly config: VeraConfig | undefined;
    // Set when the file did not load; config is then the last one that loaded from the same path.
    readonly error?: Error;
}

/**
 * `loadOptionalVeraConfig` for readers that can run on older settings: when the
 * file stops loading, the last config loaded from the same path answers instead.
 */
export function createLastGoodVeraConfigReader(
    options: LoadVeraConfigOptions = {},
): () => LastGoodVeraConfig {
    let lastGood: { readonly path: string; readonly config: VeraConfig } | undefined;
    return () => {
        const path = options.path ?? defaultVeraConfigPath();
        try {
            // Pass options through unchanged: an explicit path moves where hooks and extensions resolve.
            const config = loadOptionalVeraConfig(options);
            lastGood = config === undefined ? undefined : { path, config };
            return { config };
        } catch (error) {
            return {
                config: lastGood?.path === path ? lastGood.config : undefined,
                error: error instanceof Error ? error : new Error(String(error)),
            };
        }
    };
}

// The reason alone, without the path, for one-line notices.
export function veraConfigProblem(error: Error): string {
    return error instanceof VeraConfigError ? error.problem : error.message;
}

export function loadVeraConfig(
    options: LoadVeraConfigOptions = {},
): VeraConfig {
    const path = options.path ?? defaultVeraConfigPath();
    let source: string;

    try {
        source = readRegularFileTextSync(path);
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

    const migrated = workerConfigReadOnly ? value : migrateShippedProviderDeclarations(path, value);
    const config = checkVeraConfigValue(path, migrated);
    const hooks = config.hooks === undefined ? undefined : resolveHookCommands(
        config.hooks,
        options.path === undefined
            ? join(veraProfileDirectory(), "hooks")
            : join(dirname(path), "hooks"),
        path,
    );
    const resolved = hooks === undefined ? config : { ...config, hooks };
    const extensionDirectory = options.extensionDirectory
        ?? (options.path === undefined
            ? defaultVeraExtensionDirectory()
            : join(dirname(path), "extensions"));
    const override = extensionOverrideFromEnvironment();
    if (override !== undefined) {
        return {
            ...resolved,
            extensions: override,
        };
    }
    const explicitExtensions = config.extensions ?? [];
    const extensions = mergeExtensionConfigs(
        mergeExtensionConfigs(
            discoverExtensionConfigs(extensionDirectory),
            explicitExtensions,
        ),
        discoverManagedExtensionConfigs(extensionDirectory),
    );
    if (extensions.length === 0 && config.extensions === undefined) {
        return resolved;
    }
    return {
        ...resolved,
        extensions,
    };
}

/**
 * Every refusal `loadVeraConfig` makes about the file's contents, without
 * reading or writing the disk, so a candidate edit can be checked in memory.
 */
export function checkVeraConfigValue(path: string, value: unknown): VeraConfig {
    checkShippedProviderDeclarations(path, value);
    checkDeclaredProviderCaches(path, value);
    const movedReviewerKeys = reviewerRouteKeys(value);
    if (movedReviewerKeys.length > 0) {
        throw new VeraConfigError(
            path,
            `reviewer.${movedReviewerKeys.join(", reviewer.")} no longer`
                + " set the classifier. Remove them and assign the classifier"
                + " from Defaults in /models (model_assignments.reviewer).",
            `reviewer.${movedReviewerKeys[0]}`,
        );
    }
    const parsed = parseVeraConfig(value);
    if (parsed.config === undefined) {
        throw new VeraConfigError(
            path,
            parsed.problem === undefined
                ? "it is valid JSON but not a Vera config."
                : "it is valid JSON but not a Vera config. "
                    + `${describeConfigProblem(parsed.problem)}.`,
            parsed.problem?.field,
            parsed.problem?.reason,
        );
    }
    const config = parsed.config;
    if (config.prompt_contribution_order !== undefined) {
        try {
            validatePromptContributionOrder(config.prompt_contribution_order);
        } catch (error) {
            throw new VeraConfigError(
                path,
                error instanceof Error ? error.message : String(error),
                "prompt_contribution_order",
            );
        }
    }
    return config;
}

/**
 * Moves a shipped provider's equivalent custom declaration into the shipped
 * definition layer. This runs before parsing so an old profile can cross the
 * id-reservation boundary without a transient invalid config.
 */
export function migrateShippedProviderDeclarations(
    path: string,
    value: unknown,
): unknown {
    if (!isPlainRecord(value) || !isPlainRecord(value.providers)) {
        return value;
    }
    const declarations = Object.entries(value.providers).filter(([id]) =>
        id.trim() === "digitalocean"
    );
    if (declarations.length === 0) return value;
    if (declarations.length > 1) {
        throw new VeraConfigError(
            path,
            'provider "digitalocean" cannot migrate: more than one declaration normalizes to that id',
            `providers.${declarations[1]![0]}`,
        );
    }
    const [rawProviderId, candidate] = declarations[0]!;
    const providerField = `providers.${rawProviderId}`;
    if (!isPlainRecord(candidate)) return value;
    const declaration = candidate;
    const definition = providerDefinition("digitalocean");
    if (definition === undefined) return value;
    const protocol = declaration.protocol;
    const credential = declaration.credential ?? "api_key";
    if (protocol !== definition.protocol || credential !== "api_key") {
        throw new VeraConfigError(
            path,
            'provider "digitalocean" cannot migrate: only an openai-chat API-key declaration is representable',
            providerField,
        );
    }
    const unsupported = Object.keys(declaration).filter((key) =>
        !["protocol", "base_url", "credential", "api_key_env"].includes(key)
    );
    if (unsupported.length > 0) {
        throw new VeraConfigError(
            path,
            `provider "digitalocean" cannot migrate without losing custom field(s): ${unsupported.join(", ")}`,
            providerField,
        );
    }
    if (
        declaration.api_key_env !== undefined
        && declaration.api_key_env !== definition.env_var
    ) {
        throw new VeraConfigError(
            path,
            'provider "digitalocean" cannot migrate: api_key_env differs from the shipped definition',
            providerField,
        );
    }
    if (typeof declaration.base_url !== "string" || !isUserProviderUrl(declaration.base_url)) {
        throw new VeraConfigError(
            path,
            'provider "digitalocean" cannot migrate: base_url is invalid',
            providerField,
        );
    }
    const customBaseUrl = declaration.base_url.replace(/\/+$/, "");
    const existingEndpoints = value.provider_endpoints;
    const endpoints = existingEndpoints === undefined
        ? {}
        : isPlainRecord(existingEndpoints)
            ? { ...existingEndpoints }
            : undefined;
    if (endpoints === undefined) {
        throw new VeraConfigError(
            path,
            'provider "digitalocean" cannot migrate: provider_endpoints is not an object',
            "provider_endpoints",
        );
    }
    const existing = endpoints.digitalocean;
    if (existing !== undefined && existing !== customBaseUrl) {
        throw new VeraConfigError(
            path,
            'provider "digitalocean" cannot migrate: custom base_url conflicts with provider_endpoints.digitalocean',
            "provider_endpoints.digitalocean",
        );
    }
    const providers = { ...value.providers };
    delete providers[rawProviderId];
    const migrated = {
        ...value,
        providers: Object.keys(providers).length === 0 ? undefined : providers,
        ...(customBaseUrl === definition.default_base_url
            ? {}
            : { provider_endpoints: { ...endpoints, digitalocean: customBaseUrl } }),
    };
    writeMigratedConfig(path, migrated);
    return migrated;
}

function writeMigratedConfig(path: string, value: Record<string, unknown>): void {
    requireWritableConfig();
    const temporaryPath = join(dirname(path), `.config-migration-${randomUUID()}.tmp`);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, path);
    if ((statSync(path).mode & 0o777) !== 0o600) {
        throw new VeraConfigError(path, "provider migration did not preserve config mode 0600");
    }
}

function isPlainRecord(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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
    requireWritableConfig();
    const path = options.path ?? defaultVeraConfigPath();
    const current = existsSync(path)
        ? loadVeraConfig({ path })
        : startingVeraConfig();
    if (patch.model_assignment?.binding !== null && patch.model_assignment !== undefined) {
        const assignment = patch.model_assignment.assignment;
        const before = configuredModelAssignments(current).find((row) => row.assignment === assignment)?.declared ?? [];
        const after = configuredModelAssignments({ ...current, model_assignments: {
            ...current.model_assignments, [assignment]: patch.model_assignment.binding,
        } }).find((row) => row.assignment === assignment)?.declared ?? [];
        const pool = loadAssignmentPool({ userPath: join(dirname(path), "pool.json") }).merged;
        const requireVerified = current.verify_model_assignments === true;
        for (const model of after) {
            if (before.some((previous) => previous.provider === model.provider && previous.model === model.model)) continue;
            if (!eligibleForDefault(pool, model, { requireVerified })) throw new VeraConfigError(path,
                `${model.provider}/${model.model} must be ${requireVerified ? "verified and permitted" : "permitted"} before assigning ${assignment}.`);
        }
    }
    const updated: VeraConfig = {
        ...current,
        ...(patch.provider === undefined ? {} : { provider: patch.provider }),
        ...(patch.model === undefined ? {} : { model: patch.model }),
        ...(patch.model_request_options === undefined
            ? {}
            : {
                model_request_options: patchedModelRequestOptions(
                    path,
                    current.model_request_options,
                    patch.model_request_options,
                ),
            }),
        ...(patch.reasoning_effort === undefined
            ? {}
            : {
                reasoning_effort: patch.reasoning_effort === null
                    ? undefined
                    : patch.reasoning_effort,
            }),
        ...(patch.context_limit === undefined
            ? {}
            : {
                context_limit: patch.context_limit === null
                    ? undefined
                    : patch.context_limit,
            }),
        ...(patch.approval_mode === undefined
            ? {}
            : { approval_mode: patch.approval_mode }),
        ...(patch.reviewer === undefined
            ? {}
            : { reviewer: patch.reviewer === null ? undefined : patch.reviewer }),
        ...(patch.model_assignment === undefined
            ? {}
            : { model_assignments: patchedModelAssignments(current.model_assignments, patch.model_assignment) }),
        ...(patch.custom_provider === undefined
            ? {}
            : { providers: patchedCustomProviders(path, current.providers, patch.custom_provider) }),
        ...(patch.provider_endpoint === undefined
            ? {}
            : { provider_endpoints: patchedProviderEndpoints(path, current.provider_endpoints, patch.provider_endpoint) }),
        ...(patch.inbox === undefined
            ? {}
            : { inbox: patch.inbox === null ? undefined : patch.inbox }),
        ...(patch.tool_results === undefined
            ? {}
            : {
                tool_results: patchedToolResults(
                    current.tool_results,
                    patch.tool_results,
                ),
            }),
        ...(patch.included_extension === undefined
            ? {}
            : {
                disabled_included_extensions: patchedDisabledIncluded(
                    current.disabled_included_extensions ?? [],
                    patch.included_extension,
                ),
            }),
        ...(patch.compaction === undefined
            ? {}
            : {
                compaction: patchedCompaction(
                    current.compaction,
                    patch.compaction,
                ),
            }),
        ...(patch.provider !== undefined && patch.provider !== current.provider
            ? { fallback: undefined }
            : {}),
        ...(patch.model !== undefined && current.fallback?.model === patch.model
            ? { fallback: undefined }
            : {}),
    };
    writeVeraConfigFile(path, updated);
    return updated;
}

function patchedDisabledIncluded(
    current: readonly string[],
    patch: { readonly id: string; readonly enabled: boolean },
): readonly string[] {
    const rest = current.filter((id) => id !== patch.id);
    return patch.enabled ? rest : [...rest, patch.id];
}

/**
 * The config as it stands, creating the starting file when the machine has
 * none.
 *
 * For the entry points that have to come up on a fresh install. A missing file
 * is not a misconfiguration to report: nobody has configured anything yet, and
 * refusing to start leaves the user hand-writing JSON to reach the panes that
 * would have written it for them. A file that exists and cannot be parsed
 * still throws, because that one is an edit to be fixed rather than an absence
 * to be filled.
 */
export function loadOrCreateVeraConfig(
    options: LoadVeraConfigOptions = {},
): VeraConfig {
    const path = options.path ?? defaultVeraConfigPath();
    if (existsSync(path)) {
        return loadVeraConfig(options);
    }
    const { approval_mode: _unwritten, ...starting } = startingVeraConfig();
    writeVeraConfigFile(path, starting);
    return loadVeraConfig(options);
}

/**
 * The whole file, replaced in one step.
 *
 * Written to a temporary name and renamed over the old one, so a reader either
 * sees the previous file or the new one and never a half-written config.
 */
function writeVeraConfigFile(
    path: string,
    config: VeraConfig | Omit<VeraConfig, "approval_mode">,
): void {
    requireWritableConfig();
    // Loading resolves hooks and merges discovered and managed extensions;
    // only what the file itself declares goes back to disk.
    const { extensions: _resolvedExtensions, ...settings } = configForDisk(config);
    const written = {
        ...foreignConfigEntries(path),
        ...settings,
        ...writtenEntry(path, "hooks"),
        ...writtenEntry(path, "extensions"),
    };
    // Cross-field rules make some pairs of settings, each legal alone, invalid
    // together. A file holding such a pair does not load, and the config is
    // what the panes that would fix it are reached through, so it has to be
    // caught before the rename rather than on the next start.
    const rewritten = parseVeraConfig(
        migrateShippedProviderDeclarations(path, written),
    );
    if (rewritten.config === undefined) {
        throw new VeraConfigWriteError(
            path,
            rewritten.problem === undefined
                ? "the settings it would leave contradict each other, so the file"
                    + " it wrote could not be read back"
                : "the settings it would leave contradict each other, so the file"
                    + " it wrote could not be read back. "
                    + `${describeConfigProblem(rewritten.problem)}.`,
        );
    }
    const directory = dirname(path);
    const temporaryPath = join(directory, `.config-${randomUUID()}.tmp`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporaryPath, `${JSON.stringify(written, null, 2)}\n`, {
        mode: 0o600,
    });
    renameSync(temporaryPath, path);
}

/**
 * The config a machine with no `config.json` starts from.
 *
 * A first save creates the file rather than refusing, so the first setting a
 * new user changes is also what brings the file into being. The engine owns
 * this because the reader that defines a valid file lives here: any client
 * writing its own starting file would be guessing at that shape.
 *
 * Exported for the read-only paths, which pair it with
 * `loadOptionalVeraConfig` to answer for a machine that has none. Writing it
 * is `loadOrCreateVeraConfig`'s job, so a command that only reports on the
 * config cannot bring one into being as a side effect.
 *
 * The selection is the starting pair below: a config must name one provider,
 * so it is stated here rather than read off a list that names none.
 *
 * The approval mode is the parser's own default rather than a decision. The
 * created file omits the key so that a first save settles a model and leaves
 * the permissions posture to whoever chooses one.
 */
export const STARTING_PROVIDER = "openrouter";
export const STARTING_MODEL = "openai/gpt-5.6-sol";
export const STARTING_REASONING_EFFORT = "high";

export function startingVeraConfig(): VeraConfig {
    return {
        schema_version: VERA_CONFIG_SCHEMA_VERSION,
        provider: STARTING_PROVIDER,
        model: STARTING_MODEL,
        approval_mode: "auto",
        reasoning_effort: STARTING_REASONING_EFFORT,
    };
}

/**
 * The last valid profile config, refreshed only when the file changes.
 *
 * A caller can ask on every request without parsing on every request. An
 * absent, mid-write, or malformed file keeps the last valid answer.
 */
export function createLiveVeraConfigReader(
    initial: VeraConfig,
    options: LoadVeraConfigOptions = {},
): () => VeraConfig {
    const path = options.path ?? defaultVeraConfigPath();
    let lastConfig = initial;
    let lastStamp = "";
    return () => {
        try {
            const stamp = fileReadStamp(path);
            if (stamp === undefined) return lastConfig;
            if (stamp === lastStamp) return lastConfig;
            const loaded = loadVeraConfig({ ...options, path });
            lastStamp = stamp;
            lastConfig = loaded;
        } catch {
            // The last valid config remains usable while a save is incomplete.
        }
        return lastConfig;
    };
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
 * One assignment replaced or removed, the rest carried across untouched. Written as
 * a rebuild rather than a delete so the result stays a plain readonly record.
 */
function patchedModelAssignments(
    current: VeraModelAssignmentsConfig | undefined,
    patch: { readonly assignment: ModelAssignmentId; readonly binding: VeraModelAssignmentConfig | null },
): VeraModelAssignmentsConfig {
    const rest = Object.fromEntries(
        Object.entries(current ?? {}).filter(([name]) => name !== patch.assignment),
    ) as VeraModelAssignmentsConfig;
    return patch.binding === null
        ? rest
        : { ...rest, [patch.assignment]: patch.binding };
}

function patchedModelRequestOptions(
    path: string,
    current: VeraModelRequestOptions | undefined,
    patch: {
        readonly model: string;
        readonly body: Readonly<Record<string, JsonValue>> | null;
    },
): VeraModelRequestOptions | undefined {
    const reference = patch.model;
    const parsed = parseModelReference(reference);
    const rest = Object.fromEntries(
        Object.entries(current ?? {}).filter(([name]) => name !== reference),
    );
    if (patch.body === null) {
        return Object.keys(rest).length === 0 ? undefined : rest;
    }
    try {
        validateProviderRequestBody(
            parsed.provider,
            patch.body,
            `model_request_options.${reference}.body`,
        );
    } catch (error) {
        throw new VeraConfigError(
            path,
            error instanceof Error ? error.message : String(error),
        );
    }
    if (Object.keys(patch.body).length === 0) {
        return Object.keys(rest).length === 0 ? undefined : rest;
    }
    return {
        ...rest,
        [reference]: { body: structuredClone(patch.body) },
    };
}

/**
 * One declared provider replaced or removed, the rest carried across
 * untouched. The declaration is round-tripped through `parseCustomProviders`
 * so it is normalised and rejected on exactly the terms the loader uses,
 * including the built-in id collision the parser already refuses.
 */
function patchedCustomProviders(
    path: string,
    current: Readonly<Record<string, VeraCustomProviderConfig>> | undefined,
    patch: { readonly id: string; readonly declaration: VeraCustomProviderConfig | null },
): Readonly<Record<string, VeraCustomProviderConfig>> | undefined {
    const id = patch.id.trim();
    const rest = Object.fromEntries(
        Object.entries(current ?? {}).filter(([name]) => name !== id),
    );
    if (patch.declaration === null) {
        return Object.keys(rest).length === 0 ? undefined : rest;
    }
    const parsed = parseCustomProviders({ [id]: patch.declaration });
    if (parsed === undefined || parsed[id] === undefined) {
        throw new VeraConfigError(
            path,
            `provider "${patch.id}" is not a valid declaration`,
        );
    }
    return { ...rest, [id]: parsed[id] };
}

/**
 * One shipped provider's endpoint replaced or restored, the rest carried
 * across untouched. Validated on the same terms the loader uses, so a written
 * entry and a hand-written one cannot diverge.
 */
function patchedProviderEndpoints(
    path: string,
    current: Readonly<Record<string, string>> | undefined,
    patch: { readonly id: string; readonly url: string | null },
): Readonly<Record<string, string>> | undefined {
    const id = patch.id.trim();
    const rest = Object.fromEntries(
        Object.entries(current ?? {}).filter(([name]) => name !== id),
    );
    if (patch.url === null) {
        return Object.keys(rest).length === 0 ? undefined : rest;
    }
    const parsed = parseProviderEndpoints({ [id]: patch.url });
    if (parsed === undefined || parsed[id] === undefined) {
        throw new VeraConfigError(
            path,
            `provider "${patch.id}" cannot take endpoint "${patch.url}"`,
        );
    }
    return { ...rest, [id]: parsed[id] };
}

function foreignConfigEntries(path: string): Record<string, unknown> {
    let raw: Record<string, unknown>;
    try {
        const value: unknown = JSON.parse(readRegularFileTextSync(path));
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

/**
 * The `hooks` entries exactly as the user wrote them. Loading resolves each
 * command against the profile's `hooks/` directory, so writing the loaded
 * config back would replace the user's short names with absolute paths.
 */
function writtenEntry(path: string, key: "hooks" | "extensions"): Record<string, unknown> {
    try {
        const value: unknown = JSON.parse(readRegularFileTextSync(path));
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return {};
        }
        const entry = (value as Record<string, unknown>)[key];
        return entry === undefined ? {} : { [key]: entry };
    } catch {
        return {};
    }
}

function configForDisk(
    config: VeraConfig | Omit<VeraConfig, "approval_mode">,
): Record<string, unknown> {
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

function parseVeraConfig(
    value: unknown,
): {
    readonly config: VeraConfig | undefined;
    readonly problem: ConfigFieldProblem | undefined;
} {
    const { value: config, problem } = collectConfigProblem(() =>
        parseVeraConfigValue(value)
    );
    return { config, problem };
}

function parseVeraConfigValue(value: unknown): VeraConfig | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return configProblem("", "expected a JSON object at the top level");
    }

    const config = value as Record<string, unknown>;
    if (config.schema_version !== VERA_CONFIG_SCHEMA_VERSION) {
        return configProblem(
            "schema_version",
            expectedValue(`${VERA_CONFIG_SCHEMA_VERSION}`, config.schema_version),
        );
    }

    const host = parseHostConfig(config.host);
    if (host === undefined) return undefined;

    let modelRequestOptions: VeraModelRequestOptions | undefined;
    if (config.model_request_options !== undefined) {
        try {
            modelRequestOptions = parseModelRequestOptions(
                config.model_request_options,
            );
        } catch (error) {
            const message = error instanceof Error
                ? error.message
                : String(error);
            return configProblem(
                "model_request_options",
                message.replace(/^model_request_options[.:]?\s*/, ""),
            );
        }
    }

    const providers = parseCustomProviders(config.providers);
    if (providers === undefined) return undefined;

    const providerEndpoints = parseProviderEndpoints(config.provider_endpoints);
    if (providerEndpoints === undefined) return undefined;

    if (
        config.provider !== undefined
        && (typeof config.provider !== "string"
            || !isConfiguredProviderId(config.provider, providers))
    ) {
        return configProblem(
            "provider",
            expectedValue(
                "a provider Vera ships or a name declared in providers",
                config.provider,
            ),
        );
    }

    if (
        typeof config.model !== "string"
        || config.model.trim().length === 0
    ) {
        return configProblem(
            "model",
            expectedValue("a non-empty string", config.model),
        );
    }

    if (
        config.reasoning_effort !== undefined
        && !isReasoningEffort(config.reasoning_effort)
    ) {
        return configProblem(
            "reasoning_effort",
            expectedValue("a non-empty string", config.reasoning_effort),
        );
    }

    const contextLimit = config.context_limit;
    if (
        contextLimit !== undefined
        && (typeof contextLimit !== "number"
            || !Number.isSafeInteger(contextLimit)
            || contextLimit <= 0)
    ) {
        return configProblem(
            "context_limit",
            expectedValue("a positive whole number of tokens", contextLimit),
        );
    }

    const fallback = parseModelFallback(config.fallback, config.model);
    if (config.fallback !== undefined && fallback === undefined) return undefined;

    const reviewer = parseReviewer(config.reviewer, providers);
    if (config.reviewer !== undefined && reviewer === undefined) return undefined;

    const subagent = parseSubagentModel(config.subagent, providers);
    if (config.subagent !== undefined && subagent === undefined) return undefined;

    const modelCatalog = parseModelCatalogConfig(
        config.models,
        config.model_routes,
        config.reviewer_profiles,
        new Set(Object.keys(providers)),
    );
    if (modelCatalog === undefined) return undefined;
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
        modelCatalog.reviewer_profiles,
    );
    if (permissionModes === undefined) return undefined;
    // Routes come from the catalog, so a compaction block without one has
    // nothing to name and is rejected rather than half-resolved.
    const compaction = config.compaction === undefined
        ? undefined
        : parseCompactionConfig(
            config.compaction,
            modelCatalog.model_routes,
        );
    if (config.compaction !== undefined && compaction === undefined) {
        return undefined;
    }
    // Assignments name routes, so they parse against the same catalog compaction
    // does, and an assignment naming a route the catalog dropped rejects the block
    // rather than binding a caller to a short list.
    const modelSlots = parseModelAssignmentsConfig(
        config.model_assignments,
        modelCatalog.model_routes,
        new Set(Object.keys(providers)),
    );
    if (modelSlots === undefined) return undefined;
    const extensions = parseExtensionConfigs(config.extensions);
    if (extensions === undefined) return undefined;
    const hooks = parseHookConfigs(config.hooks);
    if (hooks === undefined) return undefined;
    const disabledIncludedExtensions = parseStringList(
        config.disabled_included_extensions,
        "disabled_included_extensions",
    );
    if (disabledIncludedExtensions === undefined) return undefined;
    const disabledPromptContributions = parseStringList(
        config.disabled_prompt_contributions,
        "disabled_prompt_contributions",
    );
    if (disabledPromptContributions === undefined) return undefined;
    const promptContributionOrder = parseStringList(
        config.prompt_contribution_order,
        "prompt_contribution_order",
    );
    if (promptContributionOrder === undefined) return undefined;
    const disabledSkills = parseSkillPatterns(config.disabled_skills);
    if (disabledSkills === undefined) return undefined;
    const experimental = parseExperimental(config.experimental);
    if (experimental === undefined) return undefined;
    const inbox = parseInboxConfig(config.inbox);
    if (inbox === undefined) return undefined;
    const toolResults = parseToolResultsConfig(config.tool_results);
    if (toolResults === undefined) return undefined;
    const promptCache = parsePromptCacheConfig(config.prompt_cache);
    if (promptCache === undefined) return undefined;
    const eventLog = parseEventLog(config.event_log, "event_log");
    if (eventLog === undefined) return undefined;
    const tips = parseEventLog(config.tips, "tips");
    if (tips === undefined) return undefined;
    const tui = parseTuiConfig(config.tui);
    if (tui === undefined) return undefined;
    const modelFeedUrl = parseModelFeedUrl(config.model_feed_url);
    if (config.model_feed_url !== undefined && modelFeedUrl === undefined) {
        return configProblem(
            "model_feed_url",
            expectedValue("an http or https URL", config.model_feed_url),
        );
    }
    const curatedModelsUrl = config.curated_models_url === ""
        ? ""
        : parseModelFeedUrl(config.curated_models_url);
    if (config.curated_models_url !== undefined && curatedModelsUrl === undefined) {
        return configProblem(
            "curated_models_url",
            expectedValue("an http or https URL", config.curated_models_url),
        );
    }
    const maxAgeMonths = parseNonNegativeCount(config.model_picker_max_age_months);
    if (
        config.model_picker_max_age_months !== undefined
        && maxAgeMonths === undefined
    ) {
        return configProblem(
            "model_picker_max_age_months",
            expectedValue(
                "a whole number of months, 0 or more",
                config.model_picker_max_age_months,
            ),
        );
    }
    const collapseVersions = config.model_picker_collapse_versions;
    if (collapseVersions !== undefined && typeof collapseVersions !== "boolean") {
        return configProblem(
            "model_picker_collapse_versions",
            expectedValue("true or false", collapseVersions),
        );
    }
    const verifyAssignments = config.verify_model_assignments;
    if (verifyAssignments !== undefined && typeof verifyAssignments !== "boolean") {
        return configProblem(
            "verify_model_assignments",
            expectedValue("true or false", verifyAssignments),
        );
    }
    const catalogMaxAgeDays = parseNonNegativeCount(
        config.model_catalog_max_age_days,
    );
    if (
        config.model_catalog_max_age_days !== undefined
        && catalogMaxAgeDays === undefined
    ) {
        return configProblem(
            "model_catalog_max_age_days",
            expectedValue(
                "a whole number of days, 0 or more",
                config.model_catalog_max_age_days,
            ),
        );
    }
    const logMaxAgeDays = parsePositiveWholeCount(config.log_max_age_days);
    if (config.log_max_age_days !== undefined && logMaxAgeDays === undefined) {
        return configProblem(
            "log_max_age_days",
            expectedValue(
                "a whole number of days, 1 or more",
                config.log_max_age_days,
            ),
        );
    }
    const contextSizeEvents = parseContextSizeEvents(config.context_size_events);
    if (contextSizeEvents === undefined) {
        return configProblem(
            "context_size_events",
            expectedValue(
                "an array of numbers above 0 and at most 1",
                config.context_size_events,
            ),
        );
    }
    const approvalMode = config.approval_mode === undefined
        ? "auto"
        : parseApprovalMode(config.approval_mode);
    if (
        approvalMode === undefined
        || (!isBuiltInPermissionMode(approvalMode)
            && permissionModes[approvalMode] === undefined)
    ) {
        return configProblem(
            "approval_mode",
            expectedValue(
                "ask, auto, full_access or a name in permission_modes",
                config.approval_mode,
            ),
        );
    }

    return {
        schema_version: VERA_CONFIG_SCHEMA_VERSION,
        ...(config.host === undefined ? {} : { host }),
        provider: config.provider ?? "openrouter",
        ...(config.providers === undefined ? {} : { providers }),
        ...(config.provider_endpoints === undefined
            ? {}
            : { provider_endpoints: providerEndpoints }),
        model: config.model.trim(),
        ...(modelRequestOptions === undefined
            ? {}
            : { model_request_options: modelRequestOptions }),
        approval_mode: approvalMode,
        ...(config.reasoning_effort === undefined
            ? {}
            : { reasoning_effort: config.reasoning_effort }),
        ...(contextLimit === undefined
            ? {}
            : { context_limit: contextLimit as number }),
        ...(config.context_size_events === undefined
            ? {}
            : { context_size_events: contextSizeEvents }),
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
            : { model_assignments: modelSlots }),
        ...(rawPermissionModes === undefined
            ? {}
            : { permission_modes: permissionModes }),
        ...(config.extensions === undefined ? {} : { extensions }),
        ...(config.hooks === undefined ? {} : { hooks }),
        ...(config.disabled_included_extensions === undefined
            ? {}
            : {
                disabled_included_extensions: disabledIncludedExtensions,
            }),
        ...(config.disabled_prompt_contributions === undefined
            ? {}
            : {
                disabled_prompt_contributions: disabledPromptContributions,
            }),
        ...(config.prompt_contribution_order === undefined
            ? {}
            : { prompt_contribution_order: promptContributionOrder }),
        ...(config.disabled_skills === undefined
            ? {}
            : { disabled_skills: disabledSkills }),
        ...(config.experimental === undefined ? {} : { experimental }),
        ...(config.inbox === undefined ? {} : { inbox }),
        ...(config.tool_results === undefined
            ? {}
            : { tool_results: toolResults }),
        ...(config.prompt_cache === undefined
            ? {}
            : { prompt_cache: promptCache }),
        ...(config.event_log === undefined ? {} : { event_log: eventLog }),
        ...(config.tips === undefined ? {} : { tips }),
        ...(config.tui === undefined ? {} : { tui }),
        ...(modelFeedUrl === undefined ? {} : { model_feed_url: modelFeedUrl }),
        ...(curatedModelsUrl === undefined
            ? {}
            : { curated_models_url: curatedModelsUrl }),
        ...(maxAgeMonths === undefined
            ? {}
            : { model_picker_max_age_months: maxAgeMonths }),
        ...(typeof collapseVersions === "boolean"
            ? { model_picker_collapse_versions: collapseVersions }
            : {}),
        ...(typeof verifyAssignments === "boolean"
            ? { verify_model_assignments: verifyAssignments }
            : {}),
        ...(catalogMaxAgeDays === undefined
            ? {}
            : { model_catalog_max_age_days: catalogMaxAgeDays }),
        ...(logMaxAgeDays === undefined
            ? {}
            : { log_max_age_days: logMaxAgeDays }),
    };
}

function parseContextSizeEvents(value: unknown): readonly number[] | undefined {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return undefined;
    const levels: number[] = [];
    for (const entry of value) {
        if (typeof entry !== "number" || !Number.isFinite(entry)
            || entry <= 0 || entry > 1) {
            return undefined;
        }
        levels.push(entry);
    }
    return [...new Set(levels)].sort((left, right) => left - right);
}

function parseHostConfig(value: unknown): VeraHostConfig | undefined {
    if (value === undefined) return {};
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return configProblem("host", expectedValue("an object", value));
    }
    const workers = (value as Record<string, unknown>).workers;
    if (workers !== undefined && (typeof workers !== "number" || !Number.isSafeInteger(workers) || workers < 0)) {
        return configProblem(
            "host.workers",
            expectedValue("a non-negative whole number", workers),
        );
    }
    return workers === undefined ? {} : { workers };
}

function parseCustomProviders(
    value: unknown,
): Readonly<Record<string, VeraCustomProviderConfig>> | undefined {
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return configProblem("providers", expectedValue("an object of provider definitions", value));
    }
    const parsed: Record<string, VeraCustomProviderConfig> = {};
    for (const [rawId, rawValue] of Object.entries(value)) {
        const id = rawId.trim();
        if (id.length === 0 || !isSafeProviderId(id)) {
            return configProblem(
                `providers.${rawId}`,
                "expected a name of lowercase letters, digits, dot, dash or underscore",
            );
        }
        if (isVeraProviderId(id)) {
            return configProblem(
                `providers.${rawId}`,
                "is built into Vera, so it cannot be declared under providers",
            );
        }
        if (
            typeof rawValue !== "object"
            || rawValue === null
            || Array.isArray(rawValue)
        ) {
            return configProblem(
                `providers.${id}`,
                expectedValue("an object", rawValue),
            );
        }
        const raw = rawValue as Record<string, unknown>;
        if (
            raw.protocol !== "openai-chat"
            && raw.protocol !== "anthropic-messages"
        ) {
            return configProblem(
                `providers.${id}.protocol`,
                expectedValue("openai-chat or anthropic-messages", raw.protocol),
            );
        }
        if (typeof raw.base_url !== "string" || !isUserProviderUrl(raw.base_url)) {
            return configProblem(
                `providers.${id}.base_url`,
                expectedValue("an http or https URL", raw.base_url),
            );
        }
        const credential = raw.credential ?? "api_key";
        if (credential !== "api_key" && credential !== "none") {
            return configProblem(
                `providers.${id}.credential`,
                expectedValue("api_key or none", raw.credential),
            );
        }
        if (
            raw.api_key_env !== undefined
            && (
                typeof raw.api_key_env !== "string"
                || !/^[A-Z_][A-Z0-9_]*$/.test(raw.api_key_env)
            )
        ) {
            return configProblem(
                `providers.${id}.api_key_env`,
                expectedValue("an environment variable name", raw.api_key_env),
            );
        }
        if (raw.images !== undefined && typeof raw.images !== "boolean") {
            return configProblem(
                `providers.${id}.images`,
                expectedValue("true or false", raw.images),
            );
        }
        if (
            raw.max_tokens !== undefined
            && (!Number.isInteger(raw.max_tokens) || (raw.max_tokens as number) <= 0)
        ) {
            return configProblem(
                `providers.${id}.max_tokens`,
                expectedValue("a positive whole number", raw.max_tokens),
            );
        }
        if (
            raw.thinking !== undefined
            && (raw.protocol !== "anthropic-messages" || raw.thinking !== "adaptive")
        ) {
            return configProblem(
                `providers.${id}.thinking`,
                raw.protocol === "anthropic-messages"
                    ? expectedValue("adaptive", raw.thinking)
                    : "only an anthropic-messages provider takes thinking",
            );
        }
        let cache: ProviderCacheDefinition | undefined;
        if (raw.cache !== undefined) {
            try {
                cache = parseCache(raw.cache, raw.protocol, `provider ${id}`);
            } catch (error) {
                const message = error instanceof Error
                    ? error.message
                    : String(error);
                return configProblem(
                    `providers.${id}.cache`,
                    message.replace(/^provider [^:]*:\s*/, ""),
                );
            }
        }
        parsed[id] = {
            protocol: raw.protocol,
            base_url: raw.base_url.replace(/\/+$/, ""),
            credential,
            ...(raw.api_key_env === undefined
                ? {}
                : { api_key_env: raw.api_key_env }),
            ...(raw.images === undefined ? {} : { images: raw.images }),
            ...(raw.max_tokens === undefined
                ? {}
                : { max_tokens: raw.max_tokens as number }),
            ...(raw.thinking === undefined
                ? {}
                : { thinking: raw.thinking as VeraAnthropicThinkingMode }),
            ...(cache === undefined ? {} : { cache }),
        };
    }
    return parsed;
}

function isConfigRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkShippedProviderDeclarations(path: string, value: unknown): void {
    if (!isConfigRecord(value) || !isConfigRecord(value.providers)) return;
    for (const rawId of Object.keys(value.providers)) {
        const id = rawId.trim();
        if (!isVeraProviderId(id)) continue;
        const redirect = isFixedEndpointProvider(id)
            ? ""
            : ` To send its requests to another URL, set provider_endpoints.${id}.`;
        throw new VeraConfigError(
            path,
            `provider "${id}" is built into Vera, so it cannot be declared under providers.`
                + ` Remove it from providers.${redirect}`,
            `providers.${rawId}`,
        );
    }
}

// The loader's one-line error cannot say what is wrong with a hand-written cache block.
function checkDeclaredProviderCaches(path: string, value: unknown): void {
    if (!isConfigRecord(value) || !isConfigRecord(value.providers)) return;
    for (const [id, declaration] of Object.entries(value.providers)) {
        if (!isConfigRecord(declaration) || declaration.cache === undefined) continue;
        if (
            declaration.protocol !== "openai-chat"
            && declaration.protocol !== "anthropic-messages"
        ) {
            continue;
        }
        try {
            parseCache(declaration.cache, declaration.protocol, `provider "${id}"`);
        } catch (error) {
            throw new VeraConfigError(
                path,
                error instanceof Error ? error.message : String(error),
                `providers.${id}.cache`,
            );
        }
    }
}

/**
 * Endpoint overrides for providers Vera ships.
 *
 * Only a shipped provider can be overridden here, because a name Vera does not
 * ship has no adapter to point somewhere else: that is what `providers` is
 * for. A provider whose endpoint is not the user's to set is refused by name,
 * so the file says the same thing the pane does.
 */
function parseProviderEndpoints(
    value: unknown,
): Readonly<Record<string, string>> | undefined {
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return configProblem(
            "provider_endpoints",
            expectedValue("an object of endpoint URLs", value),
        );
    }
    const parsed: Record<string, string> = {};
    for (const [rawId, rawUrl] of Object.entries(value)) {
        const id = rawId.trim();
        if (!isVeraProviderId(id)) {
            return configProblem(
                `provider_endpoints.${rawId}`,
                "expected a provider Vera ships; declare other providers under providers",
            );
        }
        if (isFixedEndpointProvider(id)) {
            return configProblem(
                `provider_endpoints.${rawId}`,
                "this provider's endpoint is fixed, so it cannot be changed",
            );
        }
        if (typeof rawUrl !== "string" || !isUserProviderUrl(rawUrl.trim())) {
            return configProblem(
                `provider_endpoints.${rawId}`,
                expectedValue("an http or https URL", rawUrl),
            );
        }
        parsed[id] = rawUrl.trim().replace(/\/+$/, "");
    }
    return parsed;
}

function isConfiguredProviderId(
    value: string,
    providers: Readonly<Record<string, VeraCustomProviderConfig>>,
): boolean {
    return isVeraProviderId(value) || providers[value] !== undefined;
}

function parseTuiConfig(value: unknown): VeraTuiConfig | undefined {
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return configProblem("tui", expectedValue("an object", value));
    }
    const raw = value as Record<string, unknown>;
    if (
        raw.assistant_marker !== undefined
        && raw.assistant_marker !== "●"
        && raw.assistant_marker !== "•"
        && raw.assistant_marker !== ""
    ) {
        return configProblem(
            "tui.assistant_marker",
            expectedValue('"●", "•" or ""', raw.assistant_marker),
        );
    }
    const transcript = parseTuiTranscriptConfig(raw.transcript);
    const composer = parseTuiComposerConfig(raw.composer);
    const dialogs = parseTuiDialogsConfig(raw.dialogs);
    const sidebar = parseTuiSidebarConfig(raw.sidebar);
    if (transcript === undefined || composer === undefined || dialogs === undefined || sidebar === undefined) {
        return undefined;
    }
    return {
        ...(raw.assistant_marker === undefined
            ? {}
            : { assistant_marker: raw.assistant_marker }),
        ...(raw.transcript === undefined ? {} : { transcript }),
        ...(raw.composer === undefined ? {} : { composer }),
        ...(raw.dialogs === undefined ? {} : { dialogs }),
        ...(raw.sidebar === undefined ? {} : { sidebar }),
    };
}

function parseTuiSidebarConfig(value: unknown): VeraTuiSidebarConfig | undefined {
    if (value === undefined) return {};
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return configProblem("tui.sidebar", expectedValue("an object", value));
    }
    const openAtLaunch = Reflect.get(value, "open_at_launch");
    if (openAtLaunch !== undefined && typeof openAtLaunch !== "boolean") {
        return configProblem(
            "tui.sidebar.open_at_launch",
            expectedValue("true or false", openAtLaunch),
        );
    }
    return openAtLaunch === undefined ? {} : { open_at_launch: openAtLaunch };
}

function parseTuiDialogsConfig(value: unknown): VeraTuiDialogsConfig | undefined {
    if (value === undefined) return {};
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return configProblem("tui.dialogs", expectedValue("an object", value));
    }
    const header = Reflect.get(value, "header_style");
    const search = Reflect.get(value, "search_style");
    if (header !== undefined && header !== "underline" && header !== "box") {
        return configProblem(
            "tui.dialogs.header_style",
            expectedValue("underline or box", header),
        );
    }
    if (search !== undefined && search !== "border" && search !== "fill" && search !== "plain") {
        return configProblem(
            "tui.dialogs.search_style",
            expectedValue("border, fill or plain", search),
        );
    }
    return {
        ...(header === undefined ? {} : { header_style: header }),
        ...(search === undefined ? {} : { search_style: search }),
    };
}

const TRANSCRIPT_LAYOUT_COUNTS = [
    ["padding_left", 0, 20],
    ["padding_right", 0, 20],
    ["activity_indent", 1, 12],
    ["message_spacing", 0, 5],
    ["tool_group_spacing", 0, 5],
    ["separator_spacing_before", 0, 5],
    ["separator_spacing_after", 0, 5],
] as const;

function parseTuiTranscriptConfig(
    value: unknown,
): VeraTuiTranscriptConfig | undefined {
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return configProblem("tui.transcript", expectedValue("an object", value));
    }
    const raw = value as Record<string, unknown>;
    const invalid = firstInvalidLayoutCount(raw, TRANSCRIPT_LAYOUT_COUNTS);
    if (invalid !== undefined) {
        const [key, minimum, maximum] = invalid;
        return configProblem(
            `tui.transcript.${key}`,
            expectedValue(`a whole number from ${minimum} to ${maximum}`, raw[key]),
        );
    }
    if (
        raw.separator_visible !== undefined
        && typeof raw.separator_visible !== "boolean"
    ) {
        return configProblem(
            "tui.transcript.separator_visible",
            expectedValue("true or false", raw.separator_visible),
        );
    }
    if (!isOptionalHexColor(raw.separator_color)) {
        return configProblem(
            "tui.transcript.separator_color",
            expectedValue('a colour like "#1a2b3c"', raw.separator_color),
        );
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

const COMPOSER_LAYOUT_COUNTS = [
    ["margin_horizontal", 0, 20],
    ["padding_horizontal", 0, 12],
    ["tip_indent", 0, 24],
] as const;

function parseTuiComposerConfig(
    value: unknown,
): VeraTuiComposerConfig | undefined {
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return configProblem("tui.composer", expectedValue("an object", value));
    }
    const raw = value as Record<string, unknown>;
    const invalid = firstInvalidLayoutCount(raw, COMPOSER_LAYOUT_COUNTS);
    if (invalid !== undefined) {
        const [key, minimum, maximum] = invalid;
        return configProblem(
            `tui.composer.${key}`,
            expectedValue(`a whole number from ${minimum} to ${maximum}`, raw[key]),
        );
    }
    if (!isOptionalHexColor(raw.boundary_color)) {
        return configProblem(
            "tui.composer.boundary_color",
            expectedValue('a colour like "#1a2b3c"', raw.boundary_color),
        );
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

function firstInvalidLayoutCount(
    raw: Readonly<Record<string, unknown>>,
    keys: readonly (readonly [string, number, number])[],
): (readonly [string, number, number]) | undefined {
    return keys.find(([key, minimum, maximum]) =>
        !isOptionalLayoutCount(raw[key], minimum, maximum)
    );
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

function parseNonNegativeCount(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
}

function parsePositiveWholeCount(value: unknown): number | undefined {
    return typeof value === "number" && Number.isInteger(value) && value > 0
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
        return configProblem("experimental", expectedValue("an object", value));
    }
    const raw = value as Record<string, unknown>;
    if (
        raw.outrider_onboarding !== undefined
        && typeof raw.outrider_onboarding !== "boolean"
    ) {
        return configProblem(
            "experimental.outrider_onboarding",
            expectedValue("true or false", raw.outrider_onboarding),
        );
    }
    return {
        ...(raw.outrider_onboarding === undefined
            ? {}
            : { outrider_onboarding: raw.outrider_onboarding }),
    };
}

const PROMPT_CACHE_RETENTIONS: readonly CacheRetention[] = ["none", "short", "long"];

function parsePromptCacheConfig(
    value: unknown,
): VeraPromptCacheConfig | undefined {
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return configProblem("prompt_cache", expectedValue("an object", value));
    }
    const retention = (value as Record<string, unknown>).retention;
    if (retention === undefined) {
        return {};
    }
    if (!PROMPT_CACHE_RETENTIONS.includes(retention as CacheRetention)) {
        return configProblem(
            "prompt_cache.retention",
            expectedValue(PROMPT_CACHE_RETENTIONS.join(", "), retention),
        );
    }
    return { retention: retention as CacheRetention };
}

const TOOL_RESULT_BYTE_KEYS = [
    "ceiling_bytes",
    "total_budget_bytes",
] as const;

function parseToolResultsConfig(
    value: unknown,
): VeraToolResultsConfig | undefined {
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return configProblem("tool_results", expectedValue("an object", value));
    }
    const raw = value as Record<string, unknown>;
    const parsed: Record<string, number | string> = {};
    for (const key of TOOL_RESULT_BYTE_KEYS) {
        const entry = raw[key];
        if (entry === undefined) {
            continue;
        }
        if (!Number.isSafeInteger(entry) || (entry as number) < 1) {
            return configProblem(
                `tool_results.${key}`,
                expectedValue("a whole number of bytes, 1 or more", entry),
            );
        }
        parsed[key] = entry as number;
    }
    if (raw.stub_after_turns !== undefined) {
        if (
            !Number.isSafeInteger(raw.stub_after_turns)
            || (raw.stub_after_turns as number) < 0
        ) {
            return configProblem(
                "tool_results.stub_after_turns",
                expectedValue("a whole number of turns, 0 or more", raw.stub_after_turns),
            );
        }
        parsed.stub_after_turns = raw.stub_after_turns as number;
    }
    if (raw.aging_level !== undefined) {
        if (
            typeof raw.aging_level !== "string"
            || !VERA_TOOL_RESULT_AGING_LEVELS.includes(
                raw.aging_level as VeraToolResultAgingLevel,
            )
        ) {
            return configProblem(
                "tool_results.aging_level",
                expectedValue(VERA_TOOL_RESULT_AGING_LEVELS.join(", "), raw.aging_level),
            );
        }
        parsed.aging_level = raw.aging_level;
    }
    // An explicit total must cover the configured ceiling or its default.
    const ceiling = (parsed.ceiling_bytes as number | undefined)
        ?? TOOL_RESULT_CEILING_BYTES;
    const total = parsed.total_budget_bytes as number | undefined;
    if (total !== undefined && ceiling > total) {
        return configProblem(
            "tool_results.total_budget_bytes",
            `expected at least the ceiling of ${ceiling} bytes, found ${total}`,
        );
    }
    return parsed as VeraToolResultsConfig;
}

function patchedToolResults(
    current: VeraToolResultsConfig | undefined,
    patch: Readonly<Record<string, number | string | null | undefined>>,
): VeraToolResultsConfig | undefined {
    const merged: Record<string, unknown> = { ...(current ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
            delete merged[key];
            continue;
        }
        if (value !== undefined) {
            merged[key] = value;
        }
    }
    return Object.keys(merged).length === 0
        ? undefined
        : merged as VeraToolResultsConfig;
}

function patchedCompaction(
    current: VeraCompactionConfig | undefined,
    patch: Readonly<Record<string, number | null | undefined>>,
): VeraCompactionConfig | undefined {
    const merged: Record<string, unknown> = { ...(current ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
            delete merged[key];
            continue;
        }
        if (value !== undefined) {
            merged[key] = value;
        }
    }
    return Object.keys(merged).length === 0
        ? undefined
        : merged as VeraCompactionConfig;
}

function parseInboxConfig(value: unknown): VeraInboxConfig | undefined {
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return configProblem("inbox", expectedValue("an object", value));
    }
    const raw = value as Record<string, unknown>;
    if (raw.admit === undefined) {
        return {};
    }
    if (!Array.isArray(raw.admit)) {
        return configProblem("inbox.admit", expectedValue("a list of source names", raw.admit));
    }
    const families = raw.admit.map((item) =>
        typeof item === "string" ? item.trim() : ""
    );
    const badFamily = families.findIndex((family) =>
        !/^[a-z][a-z0-9_-]*$/.test(family)
    );
    if (badFamily >= 0) {
        return configProblem(
            `inbox.admit[${badFamily}]`,
            expectedValue(
                "a name of lowercase letters, digits, dash or underscore, starting with a letter",
                raw.admit[badFamily],
            ),
        );
    }
    if (new Set(families).size !== families.length) {
        return configProblem("inbox.admit", "expected each source name once");
    }
    return { admit: families };
}

function parseEventLog(
    value: unknown,
    block: string,
): VeraEventLogConfig | undefined {
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return configProblem(block, expectedValue("an object", value));
    }
    const raw = value as Record<string, unknown>;
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
        return configProblem(
            `${block}.enabled`,
            expectedValue("true or false", raw.enabled),
        );
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

export function parseSkillPatterns(
    value: unknown,
    field = "disabled_skills",
): readonly string[] | undefined {
    const patterns = parseStringList(value, field);
    if (patterns === undefined) return undefined;
    const bad = patterns.findIndex((pattern) =>
        pattern.slice(0, -1).includes("*")
    );
    if (bad >= 0) {
        return configProblem(
            `${field}[${bad}]`,
            expectedValue("a skill name, with * allowed only at the end", patterns[bad]),
        );
    }
    return patterns;
}

function parseStringList(
    value: unknown,
    field: string,
): readonly string[] | undefined {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        return configProblem(field, expectedValue("a list of names", value));
    }
    const bad = value.findIndex((item) =>
        typeof item !== "string" || item.trim().length === 0
    );
    if (bad >= 0) {
        return configProblem(
            `${field}[${bad}]`,
            expectedValue("a non-empty string", value[bad]),
        );
    }
    const normalized = value.map((item) => item.trim());
    const repeated = normalized.findIndex((item, index) =>
        normalized.indexOf(item) !== index
    );
    if (repeated >= 0) {
        return configProblem(
            `${field}[${repeated}]`,
            `${JSON.stringify(normalized[repeated])} is listed twice`,
        );
    }
    return normalized;
}

const HOOK_PROTOCOLS = new Set(["vera", "claude"]);

function parseHookConfigs(
    value: unknown,
): readonly VeraHookConfig[] | undefined {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        return configProblem("hooks", expectedValue("a list of hooks", value));
    }
    const hooks: VeraHookConfig[] = [];
    for (const [index, item] of value.entries()) {
        const field = `hooks[${index}]`;
        if (
            typeof item !== "object"
            || item === null
            || Array.isArray(item)
        ) {
            return configProblem(field, expectedValue("an object", item));
        }
        const hook = item as Record<string, unknown>;
        const { phase, argv, protocol, timeout_ms } = hook;
        const phaseProblem = commandHookPhaseProblem(phase, protocol);
        if (phaseProblem !== undefined) {
            return configProblem(field, phaseProblem);
        }
        if (
            !Array.isArray(argv)
            || argv.length === 0
            || argv.some((argument) =>
                typeof argument !== "string" || argument.length === 0
            )
        ) {
            return configProblem(
                field,
                keyValue("argv", "a non-empty list of non-empty strings", argv),
            );
        }
        if (
            protocol !== undefined
            && (typeof protocol !== "string" || !HOOK_PROTOCOLS.has(protocol))
        ) {
            return configProblem(
                field,
                keyValue("protocol", "vera or claude", protocol),
            );
        }
        if (
            timeout_ms !== undefined
            && (typeof timeout_ms !== "number"
                || !Number.isSafeInteger(timeout_ms)
                || timeout_ms <= 0)
        ) {
            return configProblem(
                field,
                keyValue(
                    "timeout_ms",
                    "a positive whole number of milliseconds",
                    timeout_ms,
                ),
            );
        }
        hooks.push({
            phase: phase as CommandHookSpec["phase"],
            argv: [...argv as string[]],
            ...(protocol === undefined
                ? {}
                : { protocol: protocol as "vera" | "claude" }),
            ...(timeout_ms === undefined ? {} : { timeout_ms }),
        });
    }
    return hooks;
}

function commandHookPhaseProblem(
    phase: unknown,
    protocol: unknown,
): string | undefined {
    try {
        commandHookPhase(phase, protocol);
        return undefined;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

/**
 * Binds each configured hook to the profile's `hooks/` directory. A command
 * that resolves outside it is refused here rather than at the first tool call,
 * so the config names what the host will actually run.
 */
function resolveHookCommands(
    hooks: readonly VeraHookConfig[],
    hooksDirectory: string,
    configPath: string,
): readonly VeraHookConfig[] {
    return hooks.map((hook, index) => {
        const command = resolve(hooksDirectory, hook.argv[0]!);
        const inside = command === hooksDirectory
            ? false
            : command.startsWith(`${hooksDirectory}${sep}`);
        if (!inside) {
            throw new VeraConfigError(
                configPath,
                `hook command ${hook.argv[0]} is outside ${hooksDirectory}.`
                    + " A configured hook may only run a script kept there.",
                `hooks[${index}]`,
            );
        }
        return { ...hook, argv: [command, ...hook.argv.slice(1)] };
    });
}

function parseExtensionConfigs(
    value: unknown,
): readonly VeraExtensionConfig[] | undefined {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        return configProblem("extensions", expectedValue("a list of extensions", value));
    }

    const extensions: VeraExtensionConfig[] = [];
    for (const [index, item] of value.entries()) {
        const field = `extensions[${index}]`;
        if (
            typeof item !== "object"
            || item === null
            || Array.isArray(item)
        ) {
            return configProblem(field, expectedValue("an object", item));
        }
        const extension = item as Record<string, unknown>;
        if (
            typeof extension.path !== "string"
            || extension.path.trim().length === 0
            || !isAbsolute(extension.path.trim())
        ) {
            return configProblem(
                field,
                keyValue("path", "an absolute path", extension.path),
            );
        }
        if (
            extension.enabled !== undefined
            && typeof extension.enabled !== "boolean"
        ) {
            return configProblem(
                field,
                keyValue("enabled", "true or false", extension.enabled),
            );
        }
        if (extension.config !== undefined && !isJsonValue(extension.config)) {
            return configProblem(field, "config must hold JSON values only");
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

const REVIEWER_ROUTE_KEYS = [
    "model", "provider", "reasoning_effort",
    "fallback_model", "fallback_provider", "fallback_reasoning_effort",
] as const;

function reviewerRouteKeys(config: unknown): readonly string[] {
    if (typeof config !== "object" || config === null) return [];
    const reviewer = (config as Record<string, unknown>).reviewer;
    if (typeof reviewer !== "object" || reviewer === null) return [];
    return REVIEWER_ROUTE_KEYS.filter((key) => Object.hasOwn(reviewer, key));
}

function parseReviewer(
    value: unknown,
    providers: Readonly<Record<string, VeraCustomProviderConfig>>,
): VeraReviewerConfig | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!isPlainObject(value)) {
        return configProblem("reviewer", expectedValue("an object", value));
    }
    const reviewer = value as Record<string, unknown>;
    const movedKey = REVIEWER_ROUTE_KEYS.find((key) => Object.hasOwn(reviewer, key));
    if (movedKey !== undefined) {
        return configProblem(
            `reviewer.${movedKey}`,
            "the reviewer route moved to model_assignments and reviewer_profiles",
        );
    }
    if (
        reviewer.timeout_ms !== undefined
        && (typeof reviewer.timeout_ms !== "number"
            || !Number.isInteger(reviewer.timeout_ms)
            || reviewer.timeout_ms < 1_000
            || reviewer.timeout_ms > 600_000)
    ) {
        return configProblem(
            "reviewer.timeout_ms",
            expectedValue("a whole number from 1000 to 600000", reviewer.timeout_ms),
        );
    }
    if (reviewer.two_tier !== undefined && typeof reviewer.two_tier !== "boolean") {
        return configProblem(
            "reviewer.two_tier",
            expectedValue("true or false", reviewer.two_tier),
        );
    }
    if (
        reviewer.escalation_model !== undefined
        && (typeof reviewer.escalation_model !== "string"
            || reviewer.escalation_model.trim().length === 0)
    ) {
        return configProblem(
            "reviewer.escalation_model",
            expectedValue("a non-empty string", reviewer.escalation_model),
        );
    }
    if (
        reviewer.escalation_provider !== undefined
        && (typeof reviewer.escalation_provider !== "string"
            || !isConfiguredProviderId(reviewer.escalation_provider, providers))
    ) {
        return configProblem(
            "reviewer.escalation_provider",
            expectedValue(
                "a provider Vera ships or a name declared in providers",
                reviewer.escalation_provider,
            ),
        );
    }
    if (
        reviewer.escalation_reasoning_effort !== undefined
        && !isReasoningEffort(reviewer.escalation_reasoning_effort)
    ) {
        return configProblem(
            "reviewer.escalation_reasoning_effort",
            expectedValue("a non-empty string", reviewer.escalation_reasoning_effort),
        );
    }
    return {
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

function parseSubagentModel(
    value: unknown,
    providers: Readonly<Record<string, VeraCustomProviderConfig>>,
): VeraSubagentConfig | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!isPlainObject(value)) {
        return configProblem("subagent", expectedValue("an object", value));
    }
    const subagent = value as Record<string, unknown>;
    if (typeof subagent.model !== "string" || subagent.model.trim().length === 0) {
        return configProblem(
            "subagent.model",
            expectedValue("a non-empty string", subagent.model),
        );
    }
    if (
        subagent.provider !== undefined
        && (typeof subagent.provider !== "string"
            || !isConfiguredProviderId(subagent.provider, providers))
    ) {
        return configProblem(
            "subagent.provider",
            expectedValue(
                "a provider Vera ships or a name declared in providers",
                subagent.provider,
            ),
        );
    }
    if (
        subagent.reasoning_effort !== undefined
        && !isReasoningEffort(subagent.reasoning_effort)
    ) {
        return configProblem(
            "subagent.reasoning_effort",
            expectedValue("a non-empty string", subagent.reasoning_effort),
        );
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
 * Resolves the default classifier from its assignment, named profile, or
 * legacy reviewer block. `undefined` leaves classification on the agent model.
 */
export function configuredReviewer(
    config: VeraConfig,
    isReachable?: ReachabilityCheck,
): ToolReviewerSettings | undefined {
    return configuredReviewers(config, isReachable).default;
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
 * The tool result limits a config sets, or undefined when it sets none. An
 * `auto` aging level is the absence of a choice, not a level: it leaves the
 * row to be picked from the window the session actually has.
 */
export function configuredToolResults(
    config: VeraConfig,
): ToolResultLimits | undefined {
    const limits = config.tool_results;
    if (limits === undefined) {
        return undefined;
    }
    const resolved: ToolResultLimits = {
        ...(limits.ceiling_bytes === undefined
            ? {}
            : { ceilingBytes: limits.ceiling_bytes }),
        ...(limits.total_budget_bytes === undefined
            ? {}
            : { totalBudgetBytes: limits.total_budget_bytes }),
        ...(limits.stub_after_turns === undefined
            ? {}
            : { stubAfterTurns: limits.stub_after_turns }),
        ...(limits.aging_level === undefined || limits.aging_level === "auto"
            ? {}
            : { agingLevel: limits.aging_level }),
    };
    return Object.keys(resolved).length === 0 ? undefined : resolved;
}

/**
 * What the config wrote for each context lever, in the engine's own key names
 * and with nothing filled in. The defaults belong to the engine, so a value
 * missing here has to stay missing.
 */
export function configuredOverrides(config: VeraConfig): ConfiguredOverrides {
    const compaction = config.compaction;
    const limits = config.tool_results;
    return {
        ...(config.context_limit === undefined
            ? {}
            : { contextLimit: config.context_limit }),
        ...(compaction?.trigger_fraction === undefined
            ? {}
            : { compactionTriggerFraction: compaction.trigger_fraction }),
        ...(compaction?.trigger_tokens === undefined
            ? {}
            : { compactionTriggerTokens: compaction.trigger_tokens }),
        ...(compaction?.target_tokens === undefined
            ? {}
            : { compactionTargetTokens: compaction.target_tokens }),
        ...(compaction?.target_fraction === undefined
            ? {}
            : { postCompactionTargetFraction: compaction.target_fraction }),
        ...(compaction?.summary_word_cap === undefined
            ? {}
            : { summaryWordCap: compaction.summary_word_cap }),
        ...(compaction?.retained_user_turns === undefined
            ? {}
            : { retainedUserTurns: compaction.retained_user_turns }),
        ...(limits?.ceiling_bytes === undefined
            ? {}
            : { toolResultCeilingBytes: limits.ceiling_bytes }),
        ...(limits?.total_budget_bytes === undefined
            ? {}
            : { toolResultTotalBudgetBytes: limits.total_budget_bytes }),
        ...(limits?.stub_after_turns === undefined
            ? {}
            : { toolResultStubAfterTurns: limits.stub_after_turns }),
        ...(limits?.aging_level === undefined || limits.aging_level === "auto"
            ? {}
            : { toolResultAgingLevel: limits.aging_level }),
    };
}

/**
 * The config keys an override patch writes into, one per lever. The pane
 * hands back engine key names; only this table knows where each one lands.
 */
export const OVERRIDE_CONFIG_KEYS: Readonly<
    Record<OverrideKey, readonly ["context_limit" | "compaction" | "tool_results", string]>
> = {
    contextLimit: ["context_limit", "context_limit"],
    compactionTriggerFraction: ["compaction", "trigger_fraction"],
    compactionTriggerTokens: ["compaction", "trigger_tokens"],
    compactionTargetTokens: ["compaction", "target_tokens"],
    postCompactionTargetFraction: ["compaction", "target_fraction"],
    summaryWordCap: ["compaction", "summary_word_cap"],
    retainedUserTurns: ["compaction", "retained_user_turns"],
    toolResultCeilingBytes: ["tool_results", "ceiling_bytes"],
    toolResultTotalBudgetBytes: ["tool_results", "total_budget_bytes"],
    toolResultStubAfterTurns: ["tool_results", "stub_after_turns"],
    toolResultAgingLevel: ["tool_results", "aging_level"],
};

/**
 * Where one override patch lands in the config. A `null` clears that lever;
 * the blocks a patch says nothing about are left out, so writing one lever
 * never rewrites the rest.
 */
export function overridePatchDefaults(
    patch: OverrideSettingsPatch,
): VeraConfigDefaultsPatch {
    const compaction: Record<string, number | null> = {};
    const toolResults: Record<string, number | string | null> = {};
    let contextLimit: number | null | undefined;
    for (const key of OVERRIDE_KEYS) {
        const value = patch[key];
        if (value === undefined) {
            continue;
        }
        const [block, field] = OVERRIDE_CONFIG_KEYS[key];
        if (block === "context_limit") {
            contextLimit = value as number | null;
        } else if (block === "compaction") {
            compaction[field] = value as number | null;
        } else {
            toolResults[field] = value;
        }
    }
    return {
        ...(contextLimit === undefined ? {} : { context_limit: contextLimit }),
        ...(Object.keys(compaction).length === 0 ? {} : { compaction }),
        ...(Object.keys(toolResults).length === 0 ? {} : { tool_results: toolResults }),
    };
}

/**
 * The compaction numbers a config sets, or undefined when it sets none. These
 * ride over the binding rather than replacing it, so a block that names no
 * strategy still retunes the compaction the session would have run anyway.
 */
export function configuredCompactionOverrides(
    config: VeraConfig,
): CompactionOverrides | undefined {
    const compaction = config.compaction;
    if (compaction === undefined) {
        return undefined;
    }
    const overrides: CompactionOverrides = {
        ...(compaction.trigger_fraction === undefined
            ? {}
            : { triggerFraction: compaction.trigger_fraction }),
        ...(compaction.trigger_tokens === undefined
            ? {}
            : { triggerTokens: compaction.trigger_tokens }),
        ...(compaction.target_tokens === undefined
            ? {}
            : { targetTokens: compaction.target_tokens }),
        ...(compaction.target_fraction === undefined
            ? {}
            : { postCompactionTargetFraction: compaction.target_fraction }),
        ...(compaction.summary_word_cap === undefined
            ? {}
            : { summaryWordCap: compaction.summary_word_cap }),
        ...(compaction.retained_user_turns === undefined
            ? {}
            : { retainedUserTurns: compaction.retained_user_turns }),
    };
    return Object.keys(overrides).length === 0 ? undefined : overrides;
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
    return bindModelAssignment(
        {
            models: config.models ?? [],
            model_routes: config.model_routes ?? {},
            reviewer_profiles: config.reviewer_profiles ?? {},
        },
        config.model_assignments ?? {},
        { assignment: "compaction" },
        isReachable,
    ).models;
}

/**
 * Every assignment as it stands, for a surface that lists them. Inline
 * assignments need no catalog; named routes still resolve against one when it
 * exists.
 */
export function configuredModelAssignments(
    config: VeraConfig,
    isReachable?: ReachabilityCheck,
): readonly ModelAssignmentRow[] {
    return describeModelAssignments(
        {
            models: config.models ?? [],
            model_routes: config.model_routes ?? {},
            reviewer_profiles: config.reviewer_profiles ?? {},
        },
        config.model_assignments ?? {},
        isReachable,
    );
}

export function configuredReviewers(
    config: VeraConfig,
    isReachable?: ReachabilityCheck,
): Readonly<Record<string, ToolReviewerSettings>> {
    const configured: Record<string, ToolReviewerSettings> = {};
    const catalog = {
        models: config.models ?? [],
        model_routes: config.model_routes ?? {},
        reviewer_profiles: config.reviewer_profiles ?? {},
    };
    const assignment = bindModelAssignment(
        catalog,
        config.model_assignments ?? {},
        { assignment: "reviewer" },
        isReachable,
    );
    if (config.reviewer_profiles !== undefined) {
        for (const name of Object.keys(config.reviewer_profiles)) {
            const resolved = resolveReviewerProfile(
                catalog,
                name,
                assignment.models,
            );
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

    if (
        configured.default === undefined
        && assignment.models.length > 0
    ) {
        configured.default = {
            models: assignment.models.map((model) => ({
                provider: model.provider,
                model: model.model,
                ...(model.reasoning_effort === undefined
                    ? {}
                    : { reasoningEffort: model.reasoning_effort }),
            })),
        };
    }
    const reviewer = config.reviewer;
    const primary = configured.default?.models[0];
    if (reviewer === undefined || configured.default === undefined || primary === undefined) {
        return configured;
    }
    const escalationConfigured = reviewer.escalation_model !== undefined
        || reviewer.escalation_provider !== undefined
        || reviewer.escalation_reasoning_effort !== undefined;
    configured.default = {
        ...configured.default,
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
                    model: reviewer.escalation_model ?? primary.model,
                    ...(reviewer.escalation_provider === undefined
                        ? primary.provider === undefined
                            ? {}
                            : { provider: primary.provider }
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
    if (value === undefined) {
        return undefined;
    }
    if (!isPlainObject(value)) {
        return configProblem("fallback", expectedValue("an object", value));
    }
    const fallback = value as Record<string, unknown>;
    if (typeof fallback.model !== "string" || fallback.model.trim().length === 0) {
        return configProblem(
            "fallback.model",
            expectedValue("a non-empty string", fallback.model),
        );
    }
    if (
        typeof fallback.after_failures !== "number"
        || !Number.isInteger(fallback.after_failures)
        || fallback.after_failures < 1
        || fallback.after_failures > 3
    ) {
        return configProblem(
            "fallback.after_failures",
            expectedValue("a whole number from 1 to 3", fallback.after_failures),
        );
    }
    if (
        typeof primaryModel === "string"
        && fallback.model.trim() === primaryModel.trim()
    ) {
        return configProblem(
            "fallback.model",
            "must differ from model, which is already the primary",
        );
    }
    return {
        model: fallback.model.trim(),
        after_failures: fallback.after_failures,
    };
}
