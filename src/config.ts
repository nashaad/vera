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
    builtInPermissionMode,
    parseApprovalMode,
    type ApprovalMode,
} from "./engine/permissions.ts";
import {
    TOOL_RESULT_TOTAL_BUDGET_BYTES,
    type ToolResultLimits,
} from "./engine/tool-result-history.ts";
import { TOOL_RESULT_CEILING_BYTES } from "./tools/tool-result-limit.ts";
import type { CompactionOverrides } from "./engine/compaction-binding.ts";
import {
    OVERRIDE_KEYS,
    type ConfiguredOverrides,
    type OverrideKey,
} from "./engine/override-rows.ts";
import type { OverrideSettingsPatch } from "./engine/model-settings.ts";
import type { ModelFallbackPolicy } from "./engine/recovery.ts";
import type { ToolReviewerSettings } from "./engine/reviewer.ts";
import type { ModelReasoningEffort } from "./model/types.ts";
import { loadRecommendedModels } from "./model/recommended-models.ts";
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
import type { PermissionMode } from "./engine/permissions.ts";
import type { JsonValue } from "./sdk/hooks.ts";
import {
    defaultVeraExtensionDirectory,
    discoverExtensionConfigs,
    discoverManagedExtensionConfigs,
    mergeExtensionConfigs,
    mergeExtensionScopes,
    projectVeraExtensionDirectory,
} from "./extensions/discovery.ts";
import { veraProfileDirectory } from "./profile-paths.ts";
import {
    isFixedEndpointProvider,
    providerDefinition,
    shippedProviderIds,
} from "./providers/definitions.ts";
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

export function isVeraProviderId(value: string): boolean {
    return shippedProviderIds().includes(value);
}

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

export interface VeraTuiDialogsConfig {
    readonly header_style?: "underline" | "box";
    readonly search_style?: "border" | "fill" | "plain";
}

export interface VeraTuiSidebarConfig {
    readonly open_at_launch?: boolean;
}

/** Client-owned visual tuning. Absent values retain Vera's current layout. */
export interface VeraTuiConfig {
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
    readonly phase: "pre_tool_use" | "post_tool_use" | "session_start";
    readonly argv: readonly string[];
    readonly protocol?: "vera" | "claude";
    readonly timeout_ms?: number;
}

export interface VeraConfig {
    readonly schema_version: typeof VERA_CONFIG_SCHEMA_VERSION;
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
    readonly disabled_builtin_extensions?: readonly string[];
    // Skill names; a trailing `*` matches a prefix, so `["*"]` turns skills off.
    readonly disabled_skills?: readonly string[];
    readonly disabled_prompt_contributions?: readonly string[];
    readonly experimental?: VeraExperimentalConfig;
    readonly tool_results?: VeraToolResultsConfig;
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
    readonly inbox?: boolean;
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

export interface LoadVeraConfigOptions {
    readonly path?: string;
    readonly extensionDirectory?: string;
    /** Adds the explicit project's `.vera/extensions` overlay. */
    readonly projectRoot?: string;
}

export interface VeraConfigDefaultsPatch {
    readonly provider?: VeraProviderId;
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
    /**
     * Reviewer slots, written whole. `null` clears the reviewer entirely,
     * which returns auto mode to reviewing on the agent's own model.
     */
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

    const migrated = migrateShippedProviderDeclarations(path, value);
    const config = parseVeraConfig(migrated);
    if (config === undefined) {
        throw new VeraConfigError(
            path,
            "it is valid JSON but not a Vera config. It expected"
                + " schema_version 1, provider openrouter, openai-codex,"
                + " ollama, omlx, cerebras, deepseek, or a name declared in providers,"
                + " a non-empty model string, an optional"
                + " non-empty reasoning_effort string, optional approval_mode"
                + " ask, auto, or full_access, and optional fallback with a"
                + " different model and after_failures from 1 to 3.",
        );
    }
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
    const profileExtensions = mergeExtensionConfigs(
        mergeExtensionConfigs(
            discoverExtensionConfigs(extensionDirectory),
            explicitExtensions,
        ),
        discoverManagedExtensionConfigs(extensionDirectory),
    );
    const projectExtensions = options.projectRoot === undefined
        ? []
        : mergeExtensionConfigs(
            discoverExtensionConfigs(
                projectVeraExtensionDirectory(options.projectRoot),
            ),
            discoverManagedExtensionConfigs(
                projectVeraExtensionDirectory(options.projectRoot),
            ),
        );
    const extensions = mergeExtensionScopes(profileExtensions, projectExtensions);
    if (extensions.length === 0 && config.extensions === undefined) {
        return resolved;
    }
    return {
        ...resolved,
        extensions,
    };
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
        );
    }
    const [rawProviderId, candidate] = declarations[0]!;
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
        );
    }
    const unsupported = Object.keys(declaration).filter((key) =>
        !["protocol", "base_url", "credential", "api_key_env"].includes(key)
    );
    if (unsupported.length > 0) {
        throw new VeraConfigError(
            path,
            `provider "digitalocean" cannot migrate without losing custom field(s): ${unsupported.join(", ")}`,
        );
    }
    if (
        declaration.api_key_env !== undefined
        && declaration.api_key_env !== definition.env_var
    ) {
        throw new VeraConfigError(
            path,
            'provider "digitalocean" cannot migrate: api_key_env differs from the shipped definition',
        );
    }
    if (typeof declaration.base_url !== "string" || !validProviderUrl(declaration.base_url)) {
        throw new VeraConfigError(
            path,
            'provider "digitalocean" cannot migrate: base_url is invalid',
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
        );
    }
    const existing = endpoints.digitalocean;
    if (existing !== undefined && existing !== customBaseUrl) {
        throw new VeraConfigError(
            path,
            'provider "digitalocean" cannot migrate: custom base_url conflicts with provider_endpoints.digitalocean',
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
        for (const model of after) {
            if (before.some((previous) => previous.provider === model.provider && previous.model === model.model)) continue;
            if (!eligibleForDefault(pool, model)) throw new VeraConfigError(path,
                `${model.provider}/${model.model} must be verified and permitted before assigning ${assignment}.`);
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
    const written = {
        ...foreignConfigEntries(path),
        ...configForDisk(config),
        ...writtenHooks(path),
    };
    // Cross-field rules make some pairs of settings, each legal alone, invalid
    // together. A file holding such a pair does not load, and the config is
    // what the panes that would fix it are reached through, so it has to be
    // caught before the rename rather than on the next start.
    if (parseVeraConfig(migrateShippedProviderDeclarations(path, written))
        === undefined
    ) {
        throw new VeraConfigWriteError(
            path,
            "the settings it would leave contradict each other, so the file"
                + " it wrote could not be read back",
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
 * The selection is the top row of the shipped recommendations, which is the
 * same pair the getting-started page opens with.
 *
 * The approval mode is the parser's own default rather than a decision. The
 * created file omits the key so that a first save settles a model and leaves
 * the permissions posture to whoever chooses one.
 */
export function startingVeraConfig(): VeraConfig {
    const recommended = loadRecommendedModels()[0];
    if (recommended === undefined) {
        throw new Error("No recommended model to start a Vera config from.");
    }
    return {
        schema_version: VERA_CONFIG_SCHEMA_VERSION,
        provider: recommended.provider,
        model: recommended.model,
        approval_mode: "auto",
        ...(recommended.reasoning_effort === undefined
            ? {}
            : { reasoning_effort: recommended.reasoning_effort }),
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
            const stat = statSync(path);
            const stamp = `${stat.mtimeMs}:${stat.size}`;
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
function writtenHooks(path: string): Record<string, unknown> {
    try {
        const value: unknown = JSON.parse(readRegularFileTextSync(path));
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return {};
        }
        const hooks = (value as Record<string, unknown>).hooks;
        return hooks === undefined ? {} : { hooks };
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

function parseVeraConfig(value: unknown): VeraConfig | undefined {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const config = value as Record<string, unknown>;
    let modelRequestOptions: VeraModelRequestOptions | undefined;
    try {
        modelRequestOptions = config.model_request_options === undefined
            ? undefined
            : parseModelRequestOptions(config.model_request_options);
    } catch {
        return undefined;
    }
    const providers = parseCustomProviders(config.providers);
    const providerEndpoints = parseProviderEndpoints(config.provider_endpoints);
    const fallback = parseModelFallback(config.fallback, config.model);
    const reviewer = parseReviewer(config.reviewer, providers ?? {});
    const subagent = parseSubagentModel(config.subagent, providers ?? {});
    const modelCatalog = parseModelCatalogConfig(
        config.models,
        config.model_routes,
        config.reviewer_profiles,
        new Set(Object.keys(providers ?? {})),
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
    // Assignments name routes, so they parse against the same catalog compaction
    // does, and an assignment naming a route the catalog dropped rejects the block
    // rather than binding a caller to a short list.
    const modelSlots = parseModelAssignmentsConfig(
        config.model_assignments,
        modelCatalog?.model_routes ?? {},
        new Set(Object.keys(providers ?? {})),
    );
    const extensions = parseExtensionConfigs(config.extensions);
    const hooks = parseHookConfigs(config.hooks);
    const disabledBuiltinExtensions = parseStringList(
        config.disabled_builtin_extensions,
    );
    const disabledPromptContributions = parseStringList(
        config.disabled_prompt_contributions,
    );
    const disabledSkills = parseSkillPatterns(config.disabled_skills);
    const experimental = parseExperimental(config.experimental);
    const inbox = parseInboxConfig(config.inbox);
    const toolResults = parseToolResultsConfig(config.tool_results);
    const eventLog = parseEventLog(config.event_log);
    const tips = parseEventLog(config.tips);
    const tui = parseTuiConfig(config.tui);
    const modelFeedUrl = parseModelFeedUrl(config.model_feed_url);
    const curatedModelsUrl = config.curated_models_url === ""
        ? ""
        : parseModelFeedUrl(config.curated_models_url);
    const maxAgeMonths = parseNonNegativeCount(config.model_picker_max_age_months);
    const collapseVersions = config.model_picker_collapse_versions;
    const catalogMaxAgeDays = parseNonNegativeCount(
        config.model_catalog_max_age_days,
    );
    const contextLimit = config.context_limit;
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
        || providers === undefined
        || providerEndpoints === undefined
        || (config.subagent !== undefined && subagent === undefined)
        || modelCatalog === undefined
        || permissionModes === undefined
        || extensions === undefined
        || hooks === undefined
        || disabledBuiltinExtensions === undefined
        || disabledPromptContributions === undefined
        || disabledSkills === undefined
        || experimental === undefined
        || inbox === undefined
        || toolResults === undefined
        || eventLog === undefined
        || tui === undefined
        || (config.model_feed_url !== undefined && modelFeedUrl === undefined)
        || (config.curated_models_url !== undefined
            && curatedModelsUrl === undefined)
        || (config.model_picker_max_age_months !== undefined
            && maxAgeMonths === undefined)
        || (collapseVersions !== undefined
            && typeof collapseVersions !== "boolean")
        || (config.model_catalog_max_age_days !== undefined
            && catalogMaxAgeDays === undefined)
        || (config.compaction !== undefined && compaction === undefined)
        || modelSlots === undefined
        ||
        config.schema_version !== VERA_CONFIG_SCHEMA_VERSION
        || (config.provider !== undefined
            && (typeof config.provider !== "string"
                || !isConfiguredProviderId(config.provider, providers)))
        || typeof config.model !== "string"
        || config.model.trim().length === 0
        || (config.reasoning_effort !== undefined
            && !isReasoningEffort(config.reasoning_effort))
        || (contextLimit !== undefined
            && (typeof contextLimit !== "number"
                || !Number.isSafeInteger(contextLimit)
                || contextLimit <= 0))
        || !hasSelectedMode
        || (config.fallback !== undefined && fallback === undefined)
    ) {
        return undefined;
    }

    return {
        schema_version: VERA_CONFIG_SCHEMA_VERSION,
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
        ...(config.disabled_skills === undefined
            ? {}
            : { disabled_skills: disabledSkills }),
        ...(config.experimental === undefined ? {} : { experimental }),
        ...(config.inbox === undefined ? {} : { inbox }),
        ...(config.tool_results === undefined
            ? {}
            : { tool_results: toolResults }),
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
        ...(catalogMaxAgeDays === undefined
            ? {}
            : { model_catalog_max_age_days: catalogMaxAgeDays }),
    };
}

function parseCustomProviders(
    value: unknown,
): Readonly<Record<string, VeraCustomProviderConfig>> | undefined {
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const parsed: Record<string, VeraCustomProviderConfig> = {};
    for (const [rawId, rawValue] of Object.entries(value)) {
        const id = rawId.trim();
        if (
            id.length === 0
            || !isSafeProviderId(id)
            || isVeraProviderId(id)
            || typeof rawValue !== "object"
            || rawValue === null
            || Array.isArray(rawValue)
        ) {
            return undefined;
        }
        const raw = rawValue as Record<string, unknown>;
        if (
            raw.protocol !== "openai-chat"
            && raw.protocol !== "anthropic-messages"
        ) {
            return undefined;
        }
        if (typeof raw.base_url !== "string" || !validProviderUrl(raw.base_url)) {
            return undefined;
        }
        const credential = raw.credential ?? "api_key";
        if (credential !== "api_key" && credential !== "none") {
            return undefined;
        }
        if (
            raw.api_key_env !== undefined
            && (
                typeof raw.api_key_env !== "string"
                || !/^[A-Z_][A-Z0-9_]*$/.test(raw.api_key_env)
            )
        ) {
            return undefined;
        }
        if (raw.images !== undefined && typeof raw.images !== "boolean") {
            return undefined;
        }
        if (
            raw.max_tokens !== undefined
            && (!Number.isInteger(raw.max_tokens) || (raw.max_tokens as number) <= 0)
        ) {
            return undefined;
        }
        if (
            raw.thinking !== undefined
            && (raw.protocol !== "anthropic-messages" || raw.thinking !== "adaptive")
        ) {
            return undefined;
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
        };
    }
    return parsed;
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
        return undefined;
    }
    const parsed: Record<string, string> = {};
    for (const [rawId, rawUrl] of Object.entries(value)) {
        const id = rawId.trim();
        if (
            !isVeraProviderId(id)
            || isFixedEndpointProvider(id)
            || typeof rawUrl !== "string"
            || !validProviderUrl(rawUrl.trim())
        ) {
            return undefined;
        }
        parsed[id] = rawUrl.trim().replace(/\/+$/, "");
    }
    return parsed;
}

/**
 * Providers reached over an endpoint that is not a host the user can move.
 * Codex is a subscription flow bound to the account it signs in to.
 */
function validProviderUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === "https:"
            || url.protocol === "http:";
    } catch {
        return false;
    }
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
        return undefined;
    }
    const raw = value as Record<string, unknown>;
    const transcript = parseTuiTranscriptConfig(raw.transcript);
    const composer = parseTuiComposerConfig(raw.composer);
    const dialogs = parseTuiDialogsConfig(raw.dialogs);
    const sidebar = parseTuiSidebarConfig(raw.sidebar);
    if (transcript === undefined || composer === undefined || dialogs === undefined || sidebar === undefined) {
        return undefined;
    }
    return {
        ...(raw.transcript === undefined ? {} : { transcript }),
        ...(raw.composer === undefined ? {} : { composer }),
        ...(raw.dialogs === undefined ? {} : { dialogs }),
        ...(raw.sidebar === undefined ? {} : { sidebar }),
    };
}

function parseTuiSidebarConfig(value: unknown): VeraTuiSidebarConfig | undefined {
    if (value === undefined) return {};
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const openAtLaunch = Reflect.get(value, "open_at_launch");
    if (openAtLaunch !== undefined && typeof openAtLaunch !== "boolean") return undefined;
    return openAtLaunch === undefined ? {} : { open_at_launch: openAtLaunch };
}

function parseTuiDialogsConfig(value: unknown): VeraTuiDialogsConfig | undefined {
    if (value === undefined) return {};
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const header = Reflect.get(value, "header_style");
    const search = Reflect.get(value, "search_style");
    if (header !== undefined && header !== "underline" && header !== "box") return undefined;
    if (search !== undefined && search !== "border" && search !== "fill" && search !== "plain") return undefined;
    return {
        ...(header === undefined ? {} : { header_style: header }),
        ...(search === undefined ? {} : { search_style: search }),
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

function parseNonNegativeCount(value: unknown): number | undefined {
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
        return undefined;
    }
    const raw = value as Record<string, unknown>;
    const parsed: Record<string, number | string> = {};
    for (const key of TOOL_RESULT_BYTE_KEYS) {
        const entry = raw[key];
        if (entry === undefined) {
            continue;
        }
        if (!Number.isSafeInteger(entry) || (entry as number) < 1) {
            return undefined;
        }
        parsed[key] = entry as number;
    }
    if (raw.stub_after_turns !== undefined) {
        if (
            !Number.isSafeInteger(raw.stub_after_turns)
            || (raw.stub_after_turns as number) < 0
        ) {
            return undefined;
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
            return undefined;
        }
        parsed.aging_level = raw.aging_level;
    }
    // One result may not be allowed more than every result together, which
    // would let a single tool call spend a budget meant for the whole turn.
    // Setting one alone is the case that needs the defaults: lowering the
    // budget under the standing ceiling is the same contradiction written
    // with one key instead of two.
    const ceiling = (parsed.ceiling_bytes as number | undefined)
        ?? TOOL_RESULT_CEILING_BYTES;
    const total = (parsed.total_budget_bytes as number | undefined)
        ?? TOOL_RESULT_TOTAL_BUDGET_BYTES;
    if (ceiling > total) {
        return undefined;
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
        return undefined;
    }
    const raw = value as Record<string, unknown>;
    if (raw.admit === undefined) {
        return {};
    }
    if (!Array.isArray(raw.admit)) {
        return undefined;
    }
    const families = raw.admit.map((item) =>
        typeof item === "string" ? item.trim() : ""
    );
    return families.every((family) => /^[a-z][a-z0-9_-]*$/.test(family))
            && new Set(families).size === families.length
        ? { admit: families }
        : undefined;
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

function parseSkillPatterns(value: unknown): readonly string[] | undefined {
    const patterns = parseStringList(value);
    if (
        patterns === undefined
        || patterns.some((pattern) => pattern.slice(0, -1).includes("*"))
    ) {
        return undefined;
    }
    return patterns;
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

const HOOK_PROTOCOLS = new Set(["vera", "claude"]);

function parseHookConfigs(
    value: unknown,
): readonly VeraHookConfig[] | undefined {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        return undefined;
    }
    const hooks: VeraHookConfig[] = [];
    for (const item of value) {
        if (
            typeof item !== "object"
            || item === null
            || Array.isArray(item)
        ) {
            return undefined;
        }
        const hook = item as Record<string, unknown>;
        const { phase, argv, protocol, timeout_ms } = hook;
        if (
            (phase !== "pre_tool_use" && phase !== "post_tool_use" && phase !== "session_start")
            || !Array.isArray(argv)
            || argv.length === 0
            || argv.some((argument) =>
                typeof argument !== "string" || argument.length === 0
            )
            || (protocol !== undefined
                && (typeof protocol !== "string"
                    || !HOOK_PROTOCOLS.has(protocol)))
            || (timeout_ms !== undefined
                && (typeof timeout_ms !== "number"
                    || !Number.isSafeInteger(timeout_ms)
                    || timeout_ms <= 0))
        ) {
            return undefined;
        }
        hooks.push({
            phase,
            argv: [...argv as string[]],
            ...(protocol === undefined
                ? {}
                : { protocol: protocol as "vera" | "claude" }),
            ...(timeout_ms === undefined ? {} : { timeout_ms }),
        });
    }
    return hooks;
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
    return hooks.map((hook) => {
        const command = resolve(hooksDirectory, hook.argv[0]!);
        const inside = command === hooksDirectory
            ? false
            : command.startsWith(`${hooksDirectory}${sep}`);
        if (!inside) {
            throw new VeraConfigError(
                configPath,
                `hook command ${hook.argv[0]} is outside ${hooksDirectory}.`
                    + " A configured hook may only run a script kept there.",
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

function parseReviewer(
    value: unknown,
    providers: Readonly<Record<string, VeraCustomProviderConfig>>,
): VeraReviewerConfig | undefined {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }
    const reviewer = value as Record<string, unknown>;
    if (
        typeof reviewer.model !== "string"
        || reviewer.model.trim().length === 0
        || (reviewer.provider !== undefined
            && (typeof reviewer.provider !== "string"
                || !isConfiguredProviderId(reviewer.provider, providers)))
        || (reviewer.reasoning_effort !== undefined
            && !isReasoningEffort(reviewer.reasoning_effort))
        || (reviewer.fallback_model !== undefined
            && (typeof reviewer.fallback_model !== "string"
                || reviewer.fallback_model.trim().length === 0))
        || (reviewer.fallback_provider !== undefined
            && (typeof reviewer.fallback_provider !== "string"
                || !isConfiguredProviderId(reviewer.fallback_provider, providers)))
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
                || !isConfiguredProviderId(reviewer.escalation_provider, providers)))
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

function parseSubagentModel(
    value: unknown,
    providers: Readonly<Record<string, VeraCustomProviderConfig>>,
): VeraSubagentConfig | undefined {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }
    const subagent = value as Record<string, unknown>;
    if (
        typeof subagent.model !== "string"
        || subagent.model.trim().length === 0
        || (subagent.provider !== undefined
            && (typeof subagent.provider !== "string"
                || !isConfiguredProviderId(subagent.provider, providers)))
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

    const reviewer = config.reviewer;
    // The legacy plain block is still written by the direct classifier picker,
    // so it overrides only the default profile's route while preserving that
    // profile's policy. Clearing it reveals the named profile or assignment.
    if (reviewer === undefined) {
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
        return configured;
    }
    const escalationConfigured = reviewer.escalation_model !== undefined
        || reviewer.escalation_provider !== undefined
        || reviewer.escalation_reasoning_effort !== undefined;
    configured.default = {
        // A hand-written default profile may still supply the policy and any
        // timeout the direct picker did not override.
        ...configured.default,
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
