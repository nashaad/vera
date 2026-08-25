import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { VeraConfig, VeraExtensionConfig } from "../../src/config.ts";
import {
    VERA_CONFIG_SCHEMA_VERSION,
    VERA_CONFIG_ROOT_KEYS,
} from "../../src/config.ts";
import {
    VERA_HOME_ENV,
    VERA_PROFILE_ENV,
    VERA_RUNTIME_DIR_ENV,
    veraProfileName,
} from "../../src/profile-paths.ts";
import {
    isCuratedPoolEntry,
    type PoolFileModel,
} from "../../src/model/pool-file.ts";
import type { LoadedPoolFile } from "../../src/model/pool-file-loader.ts";
import { projectPoolFilePath } from "../../src/model/pool-file-loader.ts";
import { parseInboxAdmissionList } from "../../src/host/inbox-admission.ts";
import type { AuthStorage } from "../../src/providers/auth-storage.ts";
import {
    configuredProviders,
    isProviderConnected,
} from "../../src/providers/registry.ts";
import {
    loadTuiActivityAnimationIntervalPreference,
    loadTuiActivityAnimationPreference,
    loadTuiActivityAnimationWidthPreference,
    loadTuiKeybindingOverlay,
    loadTuiPinnedSessionIds,
    loadTuiSharedSessionGroups,
    loadTuiSidebarWidth,
    loadTuiThemePreference,
    loadTuiWorkspaceSidebarDocked,
    loadTuiWorkspaceSidebarWidth,
    isTuiActivityAnimation,
    isTuiThemeName,
} from "./theme-preference.ts";

export type ConfigurationCatalogSettingsTarget =
    | "model"
    | "reasoning"
    | "context_limit"
    | "permission_mode"
    | "developer"
    | "reviewer"
    | "provider"
    | "model_shortlist"
    | "model_assignments"
    | "theme"
    | "preferences"
    | "extensions"
    | "agent";

export type ConfigurationCatalogAction =
    | {
        readonly kind: "settings";
        readonly target: ConfigurationCatalogSettingsTarget;
    }
    | {
        readonly kind: "raw";
        readonly path: string;
        /** Directories must stay directories when they do not exist yet. */
        readonly target?: "file" | "directory";
    }
    | {
        readonly kind: "provider";
    }
    | {
        readonly kind: "readonly";
        readonly reason: string;
    };

export interface ConfigurationCatalogEntry {
    /** Stable client-local identity used by picker selection and tests. */
    readonly id: string;
    readonly group: string;
    readonly label: string;
    readonly description: string;
    readonly value: string;
    /** Exact file, environment variable, or flag a person can look up. */
    readonly location: string;
    readonly scope: string;
    readonly apply: string;
    readonly action: ConfigurationCatalogAction;
    readonly searchText?: string;
    readonly facts?: readonly (readonly [string, string])[];
}

export interface ConfigurationCatalogContext {
    readonly config?: VeraConfig;
    readonly configError?: string;
    readonly projectRoot: string;
    readonly currentSession?: {
        readonly provider?: string;
        readonly model: string;
        readonly reasoningEffort?: string;
        readonly permissionMode?: string;
    };
    readonly theme?: string;
    readonly authStorage?: Pick<AuthStorage, "getCredential">;
    readonly pool?: LoadedPoolFile;
    readonly permissionPreferenceCount?: number;
    readonly clientExtensions?: readonly VeraExtensionConfig[];
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly startupProfile?: string;
}

/**
 * Root keys Vera understands in the profile config. Keep this list beside the
 * registry so an unknown root key can be named instead of looking like a
 * supported setting that the loader silently ignored.
 */
export const VERA_CONFIG_CATALOG_KEYS: readonly string[] = VERA_CONFIG_ROOT_KEYS;

const PROFILE_GROUP = "Profile defaults";
const PROVIDER_GROUP = "Providers and credentials";
const MODEL_GROUP = "Models and routing";
const PERMISSION_GROUP = "Permissions and review";
const EXTENSION_GROUP = "Extensions and hooks";
const TUI_GROUP = "TUI preferences";
const WORKSPACE_GROUP = "Workspace and inbox";
const LAUNCH_GROUP = "Launch and diagnostics";
const STATE_GROUP = "Managed state";

export function buildConfigurationCatalog(
    context: ConfigurationCatalogContext,
): readonly ConfigurationCatalogEntry[] {
    const entries: ConfigurationCatalogEntry[] = [];
    const environment = context.environment ?? process.env;
    const profilePath = profileDirectory(environment);
    const machinePath = machineDirectory(environment);
    const configPath = join(profilePath, "config.json");
    const userPoolPath = environment.VERA_POOL_FILE?.trim()
        || join(profilePath, "pool.json");
    const projectPoolPath = projectPoolFilePath(context.projectRoot);
    const preferencesPath = join(profilePath, "preferences.json");
    const tuiPath = join(profilePath, "tui.json");
    const authPath = join(machinePath, "auth.json");
    const projectConfigPath = join(context.projectRoot, ".vera", "config.json");
    const configRecord = readJsonRecord(configPath);
    const tuiRecordResult = readJsonRecord(tuiPath);
    const tuiRecord = tuiRecordResult.value;
    const projectConfigRecord = readJsonRecord(projectConfigPath);
    const rawConfig = configRecord.value;
    const config = context.config;
    const configValues = config as unknown as
        | Record<string, unknown>
        | undefined;
    const setting = (input: {
        readonly id: string;
        readonly group: string;
        readonly label: string;
        readonly description: string;
        readonly value: string;
        readonly location: string;
        readonly scope: string;
        readonly apply: string;
        readonly action: ConfigurationCatalogAction;
        readonly searchText?: string;
        readonly facts?: readonly (readonly [string, string])[];
    }): void => {
        entries.push(input);
    };
    const profileSetting = (input: {
        readonly id: string;
        readonly label: string;
        readonly description: string;
        readonly path: string;
        readonly value: string;
        readonly action?: ConfigurationCatalogAction;
        readonly apply?: string;
        readonly facts?: readonly (readonly [string, string])[];
        readonly searchText?: string;
    }): void => {
        setting({
            id: input.id,
            group: PROFILE_GROUP,
            label: input.label,
            description: input.description,
            value: input.value,
            location: `${configPath}#${input.path}`,
            scope: "profile",
            apply: input.apply ?? "new sessions",
            action: input.action ?? { kind: "raw", path: configPath },
            ...(input.searchText === undefined
                ? {}
                : { searchText: input.searchText }),
            facts: input.facts,
        });
    };
    const rawProfileSetting = (input: {
        readonly id: string;
        readonly label: string;
        readonly description: string;
        readonly path: string;
        readonly value: string;
        readonly apply?: string;
        readonly facts?: readonly (readonly [string, string])[];
        readonly searchText?: string;
    }): void => profileSetting(input);
    const existing = (path: string): string =>
        existsSync(path) ? "created" : "not created";
    const count = (value: unknown): number =>
        Array.isArray(value)
            ? value.length
            : value !== null && typeof value === "object"
            ? Object.keys(value as Record<string, unknown>).length
            : 0;
    const listValue = (value: unknown, empty = "not set"): string => {
        if (!Array.isArray(value) || value.length === 0) return empty;
        return value.map((item) => String(item)).join(", ");
    };
    const objectValue = (value: unknown, empty = "not set"): string => {
        const total = count(value);
        return total === 0 ? empty : `${total} configured`;
    };
    const valueOr = (value: unknown, fallback: string): string =>
        value === undefined || value === null ? fallback : String(value);
    const poolCounts = (models: Readonly<Record<string, PoolFileModel>> | undefined): {
        readonly curated: number;
        readonly learnedOnly: number;
    } => {
        let curated = 0;
        let learnedOnly = 0;
        for (const entry of Object.values(models ?? {})) {
            if (isCuratedPoolEntry(entry)) curated += 1;
            else learnedOnly += 1;
        }
        return { curated, learnedOnly };
    };
    const userPoolCounts = poolCounts(context.pool?.user.models);
    const projectPoolCounts = poolCounts(context.pool?.project.models);
    const configField = (path: string): unknown => {
        if (config === undefined || configValues === undefined) return undefined;
        const [root, child] = path.split(".");
        const value = configValues[root ?? ""];
        return child === undefined || value === undefined
            ? value
            : typeof value === "object" && value !== null
            ? (value as Record<string, unknown>)[child]
            : undefined;
    };

    profileSetting({
        id: "config.schema_version",
        label: "Config schema",
        description: "format version Vera expects",
        path: "schema_version",
        value: valueOr(configField("schema_version"), String(VERA_CONFIG_SCHEMA_VERSION)),
        action: {
            kind: "readonly",
            reason: "Vera owns this value; do not edit it by hand.",
        },
        apply: "startup",
    });
    profileSetting({
        id: "config.provider",
        label: "Default provider",
        description: "provider used by new sessions",
        path: "provider",
        value: valueOr(configField("provider"), "built-in default"),
        action: { kind: "raw", path: configPath },
    });
    profileSetting({
        id: "config.model",
        label: "Default model",
        description: "model inherited by new sessions",
        path: "model",
        value: valueOr(configField("model"), "built-in recommendation"),
        action: { kind: "settings", target: "model" },
        facts: context.currentSession === undefined
            ? undefined
            : [[
                "This session",
                formatSessionModel(context.currentSession),
            ]],
    });
    profileSetting({
        id: "config.reasoning_effort",
        label: "Default reasoning",
        description: "reasoning level inherited by new sessions",
        path: "reasoning_effort",
        value: valueOr(configField("reasoning_effort"), "model default"),
        // The reasoning picker is session-scoped: when a session has an
        // override it writes that pair back as the default. This row names the
        // profile default, so it must go to the owning file instead.
        action: { kind: "raw", path: configPath },
    });
    profileSetting({
        id: "config.context_limit",
        label: "Context limit",
        description: "global ceiling across model windows",
        path: "context_limit",
        value: configField("context_limit") === undefined
            ? "model maximum"
            : String(configField("context_limit")),
        action: { kind: "settings", target: "context_limit" },
    });
    profileSetting({
        id: "config.approval_mode",
        label: "Permission mode",
        description: "what Vera may run and when it asks",
        path: "approval_mode",
        value: valueOr(configField("approval_mode"), "auto"),
        action: { kind: "settings", target: "permission_mode" },
        facts: context.currentSession?.permissionMode === undefined
            ? undefined
            : [["This session", context.currentSession.permissionMode]],
    });

    rawProfileSetting({
        id: "config.fallback",
        label: "Model fallback",
        description: "backup model after consecutive provider failures",
        path: "fallback",
        value: objectValue(configField("fallback"), "not configured"),
        facts: objectFacts(configField("fallback"), [
            "model",
            "after_failures",
        ]),
    });
    rawProfileSetting({
        id: "config.subagent",
        label: "Legacy subagent default",
        description: "model used when no named subagent assignment applies",
        path: "subagent",
        value: objectValue(configField("subagent"), "inherits the session"),
        facts: objectFacts(configField("subagent"), [
            "provider",
            "model",
            "reasoning_effort",
        ]),
    });

    setting({
        id: "config.providers",
        group: PROVIDER_GROUP,
        label: "Custom providers",
        description: "OpenAI- or Anthropic-compatible endpoints declared by you",
        value: objectValue(config?.providers, "none"),
        location: `${configPath}#providers`,
        scope: "profile",
        apply: "host restart",
        action: { kind: "settings", target: "provider" },
        searchText: "provider endpoint protocol credential api key",
        facts: objectFacts(config?.providers, Object.keys(config?.providers ?? {})),
    });
    for (const [id, declaration] of Object.entries(config?.providers ?? {})) {
        setting({
            id: `config.providers.entry.${id}`,
            group: PROVIDER_GROUP,
            label: `Custom provider: ${id}`,
            description: "one named OpenAI- or Anthropic-compatible provider declaration",
            value: `${declaration.protocol} · ${redactUrl(declaration.base_url)}`,
            location: `${configPath}#providers.${id}`,
            scope: "profile",
            apply: "host restart",
            action: { kind: "settings", target: "provider" },
            searchText: `${id} ${declaration.protocol} ${declaration.credential} provider declaration`,
            facts: [
                ["Protocol", declaration.protocol],
                ["Base URL", redactUrl(declaration.base_url)],
                ["Credential", declaration.credential],
                ["API key environment", declaration.api_key_env ?? "not set"],
                ["Images", declaration.images === undefined ? "default" : String(declaration.images)],
                ["Max tokens", declaration.max_tokens === undefined ? "default" : String(declaration.max_tokens)],
                ["Thinking", declaration.thinking ?? "default"],
            ],
        });
    }
    rawProfileSetting({
        id: "config.providers.advanced",
        label: "Provider advanced options",
        description: "image support, output caps, thinking mode, and key environment names",
        path: "providers.<name>",
        value: objectValue(config?.providers, "none"),
        apply: "host restart",
        searchText: "providers images max_tokens thinking api_key_env",
    });
    setting({
        id: "config.provider_endpoints",
        group: PROVIDER_GROUP,
        label: "Provider endpoint overrides",
        description: "move a shipped provider to a region, proxy, or gateway",
        value: objectValue(config?.provider_endpoints, "using shipped endpoints"),
        location: `${configPath}#provider_endpoints`,
        scope: "profile",
        apply: "host restart",
        action: { kind: "settings", target: "provider" },
        searchText: "provider host url ollama omlx openrouter",
        facts: objectFacts(config?.provider_endpoints, Object.keys(config?.provider_endpoints ?? {})),
    });

    const providers = configuredProviders(config);
    for (const provider of providers) {
        let connected = false;
        try {
            connected = isProviderConnected(provider, {
                authStorage: context.authStorage,
                env: context.environment,
            });
        } catch {
            connected = false;
        }
        let storedCredential = false;
        try {
            storedCredential = context.authStorage?.getCredential(provider.id)
                !== undefined;
        } catch {
            storedCredential = false;
        }
        const environmentCredential = provider.envVar !== undefined
            && environment[provider.envVar]?.trim() !== ""
            && environment[provider.envVar] !== undefined;
        const credentialSource = provider.credential === "none"
            ? "local endpoint · no credential"
            : provider.credential === "api_key_optional" && !storedCredential
            && !environmentCredential
            ? "local endpoint · optional credential not set"
            : storedCredential && environmentCredential
            ? `stored credential wins · ${provider.envVar} also set`
            : storedCredential
            ? "stored credential"
            : environmentCredential
            ? `${provider.envVar} environment credential`
            : "no credential source";
        const environmentHint = provider.envVar === undefined
            ? ""
            : ` or ${provider.envVar}`;
        setting({
            id: `auth.${provider.id}`,
            group: PROVIDER_GROUP,
            label: `${provider.label} credentials`,
            description: connected
                ? `connected · ${provider.credential === "none" ? "no secret required" : "secret not shown"}`
                : `not connected${environmentHint}`,
            value: connected ? credentialSource : "not connected",
            location: storedCredential
                ? environmentCredential && provider.envVar !== undefined
                    ? `${authPath} (effective) · ${provider.envVar} (ignored while stored exists)`
                    : authPath
                : environmentCredential && provider.envVar !== undefined
                ? provider.envVar
                : provider.envVar === undefined
                ? authPath
                : `${authPath} or ${provider.envVar}`,
            scope: provider.credential === "oauth" ? "machine" : "machine or environment",
            apply: "next turn",
            action: { kind: "provider" },
            searchText: `${provider.id} ${provider.label} credential api key oauth secret ${provider.envVar ?? ""}`,
            facts: [
                ["Status", connected ? "connected" : "not connected"],
                ["Credential", provider.credential],
                ["Effective source", credentialSource],
                ["Stored file", storedCredential ? `${authPath} · wins` : "not set"],
                ...(provider.envVar === undefined
                    ? []
                    : [[
                        "Environment",
                        !environmentCredential
                            ? "not set"
                            : `${provider.envVar} set · value hidden`,
                    ] as const]),
            ],
        });
        if (provider.envVar?.endsWith("_HOST") === true) {
            setting({
                id: `launch.provider.${provider.id}.endpoint`,
                group: LAUNCH_GROUP,
                label: `${provider.label} endpoint override`,
                description: "launch environment endpoint used instead of the built-in host",
                value: redactUrl(
                    environment[provider.envVar]?.trim()
                        || provider.baseUrl
                        || "built-in endpoint",
                ),
                location: provider.envVar,
                scope: "launch",
                apply: "next host start",
                action: {
                    kind: "readonly",
                    reason: `Set ${provider.envVar} before launching Vera; this TUI cannot change the process environment.`,
                },
                searchText: `${provider.id} endpoint host ${provider.envVar}`,
            });
        }
    }

    setting({
        id: "pool.user",
        group: MODEL_GROUP,
        label: "User model shortlist",
        description: "models you keep available for defaults and assignments",
        value: `${userPoolCounts.curated} curated models · ${existing(userPoolPath)}`
            + (userPoolCounts.learnedOnly === 0
                ? ""
                : ` · ${userPoolCounts.learnedOnly} learned-only`),
        location: userPoolPath,
        scope: "profile",
        apply: "next picker/session",
        action: { kind: "settings", target: "model_shortlist" },
        searchText: "pool shortlist pinned models",
    });
    setting({
        id: "pool.project",
        group: MODEL_GROUP,
        label: "Project model shortlist",
        description: "project additions and overrides to the user shortlist",
        value: `${projectPoolCounts.curated} curated models · ${existing(projectPoolPath)}`
            + (projectPoolCounts.learnedOnly === 0
                ? ""
                : ` · ${projectPoolCounts.learnedOnly} learned-only`),
        location: projectPoolPath,
        scope: "project",
        apply: "next picker/session",
        action: { kind: "raw", path: projectPoolPath },
        searchText: "pool project shortlist models",
    });
    setting({
        id: "pool.defaults",
        group: MODEL_GROUP,
        label: "Pool defaults and policy",
        description: "user-scope subagent default, effort, allow list, and deny list",
        value: objectValue(context.pool?.user.defaults, "not configured"),
        location: `${userPoolPath}#defaults`,
        scope: "profile",
        apply: "new sessions",
        action: { kind: "raw", path: userPoolPath },
        searchText: "pool defaults subagent effort allow deny",
        facts: objectFacts(context.pool?.user.defaults, [
            "subagent",
            "subagentEffort",
            "allow",
            "deny",
        ]),
    });
    setting({
        id: "pool.project_defaults",
        group: MODEL_GROUP,
        label: "Project pool defaults",
        description: "project-scope overrides for model policy and subagent defaults",
        value: objectValue(context.pool?.project.defaults, "not configured"),
        location: `${projectPoolPath}#defaults`,
        scope: "project",
        apply: "new sessions",
        action: { kind: "raw", path: projectPoolPath },
        searchText: "project pool defaults subagent effort allow deny",
        facts: objectFacts(context.pool?.project.defaults, [
            "subagent",
            "subagentEffort",
            "allow",
            "deny",
        ]),
    });
    setting({
        id: "pool.model_facts",
        group: MODEL_GROUP,
        label: "Per-model pool facts",
        description: "user-scope capabilities, effort mappings, fallbacks, and learned probe facts",
        value: `${userPoolCounts.curated} curated · ${userPoolCounts.learnedOnly} learned-only`,
        location: `${userPoolPath}#models`,
        scope: "profile",
        apply: "next picker/session",
        action: { kind: "raw", path: userPoolPath },
        searchText: "pool models tools images context efforts fallback learned",
    });
    setting({
        id: "pool.project_model_facts",
        group: MODEL_GROUP,
        label: "Project per-model pool facts",
        description: "project-scope model capability and fallback overrides",
        value: `${projectPoolCounts.curated} curated · ${projectPoolCounts.learnedOnly} learned-only`,
        location: `${projectPoolPath}#models`,
        scope: "project",
        apply: "next picker/session",
        action: { kind: "raw", path: projectPoolPath },
        searchText: "project pool models tools images context efforts fallback learned",
    });
    for (const [index, issue] of (context.pool?.issues ?? []).entries()) {
        const issuePath = issue.scope === "user"
            ? userPoolPath
            : projectPoolPath;
        setting({
            id: `pool.issue.${issue.scope}.${index}`,
            group: MODEL_GROUP,
            label: `${issue.scope} pool file issue${issue.path === ""
                ? ""
                : `: ${issue.path}`}`,
            description: issue.message,
            value: "not applied",
            location: issuePath,
            scope: issue.scope === "user" ? "profile" : "project",
            apply: "fix file and reopen",
            action: { kind: "raw", path: issuePath },
            searchText: `pool issue ${issue.path} ${issue.message}`,
        });
    }
    rawProfileSetting({
        id: "config.models",
        label: "Named model catalog",
        description: "models used by routes, compaction, and assignments",
        path: "models",
        value: `${count(config?.models)} entries`,
        apply: "host restart",
    });
    rawProfileSetting({
        id: "config.model_routes",
        label: "Model routes",
        description: "ordered named model choices for internal work",
        path: "model_routes",
        value: `${count(config?.model_routes)} routes`,
        apply: "host restart",
    });
    rawProfileSetting({
        id: "config.reviewer_profiles",
        label: "Reviewer profiles",
        description: "named reviewer policies and timeouts",
        path: "reviewer_profiles",
        value: `${count(config?.reviewer_profiles)} profiles`,
        apply: "host restart",
    });
    setting({
        id: "config.model_assignments",
        group: MODEL_GROUP,
        label: "Model assignments",
        description: "models for snappy, eco, extra, compaction, reviewer, and subagents",
        value: `${count(config?.model_assignments)} assignments`,
        location: `${configPath}#model_assignments`,
        scope: "profile",
        apply: "new sessions",
        action: { kind: "settings", target: "model_assignments" },
        searchText: "defaults assignments subagents compaction reviewer snappy eco extra",
        facts: Object.entries(config?.model_assignments ?? {}).map(([name, value]) => [
            name,
            formatAssignmentValue(value),
        ] as const),
    });
    rawProfileSetting({
        id: "config.model_assignments.never_auto",
        label: "Automatic assignment exclusions",
        description: "jobs that automatic selection must not claim",
        path: "model_assignments.never_auto",
        value: objectValue(config?.model_assignments?.never_auto, "none"),
        searchText: "never auto exclusions assignments",
    });
    rawProfileSetting({
        id: "config.compaction",
        label: "Compaction policy",
        description: "when sessions summarize and which model slots summarize them",
        path: "compaction",
        value: objectValue(config?.compaction, "built-in policy"),
        facts: objectFacts(config?.compaction, [
            "strategy",
            "models",
            "timeout_ms",
            "trigger_fraction",
            "trigger_tokens",
            "target_tokens",
            "retained_user_turns",
        ]),
    });
    rawProfileSetting({
        id: "config.model_feed_url",
        label: "Model feed URL",
        description: "optional curated model feed source",
        path: "model_feed_url",
        value: config?.model_feed_url === undefined
            ? "shipped feed"
            : redactUrl(config.model_feed_url),
        apply: "host restart",
    });
    rawProfileSetting({
        id: "config.model_picker_max_age_months",
        label: "Model age filter",
        description: "how old a provider listing may be in the picker",
        path: "model_picker_max_age_months",
        value: valueOr(config?.model_picker_max_age_months, "built-in cutoff"),
        apply: "next provider catalog refresh or host restart",
    });
    rawProfileSetting({
        id: "config.model_picker_collapse_versions",
        label: "Collapse model versions",
        description: "fold older same-family releases under the newest one",
        path: "model_picker_collapse_versions",
        value: valueOr(config?.model_picker_collapse_versions, "off"),
        apply: "next provider catalog refresh or host restart",
    });
    rawProfileSetting({
        id: "config.model_catalog_max_age_days",
        label: "Model catalog cache age",
        description: "how long discovered provider model lists stay fresh",
        path: "model_catalog_max_age_days",
        value: valueOr(config?.model_catalog_max_age_days, "7 days"),
        apply: "host restart",
    });

    setting({
        id: "config.reviewer",
        group: PERMISSION_GROUP,
        label: "Reviewer models",
        description: "primary and failsafe models used by automatic review",
        value: objectValue(config?.reviewer, "uses the agent model"),
        location: `${configPath}#reviewer`,
        scope: "profile",
        apply: "new sessions",
        action: { kind: "settings", target: "reviewer" },
        searchText: "reviewer approval primary failsafe fallback model",
        facts: objectFacts(config?.reviewer, [
            "provider",
            "model",
            "reasoning_effort",
            "fallback_provider",
            "fallback_model",
            "fallback_reasoning_effort",
        ]),
    });
    rawProfileSetting({
        id: "config.reviewer.advanced",
        label: "Reviewer advanced policy",
        description: "timeout, two-tier review, and escalation model",
        path: "reviewer.timeout_ms / reviewer.two_tier / reviewer.escalation_*",
        value: config?.reviewer === undefined
            ? "not configured"
            : `${config.reviewer.two_tier === true ? "two-tier" : "one-pass"} · ${config.reviewer.timeout_ms ?? "default timeout"}`,
        searchText: "reviewer timeout two tier escalation",
        facts: objectFacts(config?.reviewer, [
            "timeout_ms",
            "two_tier",
            "escalation_provider",
            "escalation_model",
            "escalation_reasoning_effort",
        ]),
    });
    rawProfileSetting({
        id: "config.permission_modes",
        label: "Custom permission modes",
        description: "named allow/review/ask/deny policies",
        path: "permission_modes",
        value: objectValue(config?.permission_modes, "built-in modes only"),
        facts: objectFacts(config?.permission_modes, Object.keys(config?.permission_modes ?? {})),
        searchText: "permissions modes rules custom policy",
    });
    for (const [name, mode] of Object.entries(config?.permission_modes ?? {})) {
        setting({
            id: `config.permission_modes.${name}`,
            group: PERMISSION_GROUP,
            label: `Permission mode: ${name}`,
            description: "custom permission policy and its ordered rules",
            value: `${mode.defaultOutcome} · ${mode.rules.length} rules`,
            location: `${configPath}#permission_modes.${name}`,
            scope: "profile",
            apply: "new sessions",
            action: { kind: "raw", path: configPath },
            searchText: `${name} permission mode allow review ask deny rules`,
            facts: [
                ["Default", mode.defaultOutcome],
                ["Reviewer profile", mode.reviewerProfile ?? "not set"],
                ["Rules", String(mode.rules.length)],
            ],
        });
    }
    if (hasRawKey(rawConfig, "permission_profiles")) {
        rawProfileSetting({
            id: "config.permission_profiles",
            label: "Deprecated permission mode alias",
            description: "older spelling retained for compatibility",
            path: "permission_profiles",
            value: "present; rewritten as permission_modes on save",
            searchText: "permission profiles deprecated alias",
        });
    }
    setting({
        id: "preferences.permissions",
        group: PERMISSION_GROUP,
        label: "Durable permission preferences",
        description: "saved approvals that survive across sessions",
        value: context.permissionPreferenceCount === undefined
            ? `${existing(preferencesPath)} · count unavailable`
            : `${context.permissionPreferenceCount} preferences · ${existing(preferencesPath)}`,
        location: preferencesPath,
        scope: "profile",
        apply: "next permission decision",
        action: { kind: "settings", target: "preferences" },
        searchText: "permissions grants approvals preferences",
    });

    setting({
        id: "config.developer",
        group: PROFILE_GROUP,
        label: "Developer overrides",
        description: "test-only context and compaction overrides",
        value: config?.developer?.enabled === true ? "on" : "off",
        location: `${configPath}#developer`,
        scope: "profile",
        apply: "new sessions",
        action: { kind: "settings", target: "developer" },
        searchText: "developer debug testing compaction context summary",
        facts: objectFacts(config?.developer, [
            "enabled",
            "context_limit",
            "compaction_trigger_fraction",
            "post_compaction_target_fraction",
            "summary_word_cap",
        ]),
    });
    rawProfileSetting({
        id: "config.event_log",
        label: "Event log",
        description: "whether Vera records per-session diagnostic events",
        path: "event_log",
        value: config?.event_log?.enabled === false ? "off" : "on",
        apply: "host restart",
        searchText: "event log diagnostics inspect enabled",
    });
    rawProfileSetting({
        id: "config.tips",
        label: "Discovery tips",
        description: "whether Vera shows key and workflow tips",
        path: "tips",
        value: config?.tips?.enabled === false ? "off" : "on",
        apply: "next client start",
        searchText: "tips help key bindings discovery",
    });

    const profileExtensionDirectory = join(profilePath, "extensions");
    const projectExtensionDirectory = join(
        context.projectRoot,
        ".vera",
        "extensions",
    );
    setting({
        id: "config.extensions",
        group: EXTENSION_GROUP,
        label: "Profile extension declarations",
        description: "explicit extension entries written in the profile config file",
        value: `${Array.isArray(rawConfig?.extensions) ? rawConfig.extensions.length : 0} explicit`,
        location: `${configPath}#extensions`,
        scope: "profile config",
        apply: "restart required",
        action: { kind: "raw", path: configPath },
        searchText: "extension install enable disable config profile declaration",
        facts: extensionFacts(
            Array.isArray(rawConfig?.extensions)
                ? rawConfig.extensions as VeraExtensionConfig[]
                : undefined,
        ),
    });
    setting({
        id: "extensions.effective",
        group: EXTENSION_GROUP,
        label: "Effective extension set",
        description: "the merged list after profile, project, managed, and launch sources",
        value: `${context.clientExtensions?.length ?? config?.extensions?.length ?? 0} active`,
        location: `${configPath}#extensions + ${profileExtensionDirectory} + ${projectExtensionDirectory} + VERA_EXTENSIONS`,
        scope: "profile, project, and launch",
        apply: "host/client restart",
        action: {
            kind: "readonly",
            reason: "The active list is assembled from several owners. Edit the matching profile/project declaration, registry, or VERA_EXTENSIONS source shown here.",
        },
        searchText: "extension effective active merged project managed VERA_EXTENSIONS",
        facts: extensionFacts(context.clientExtensions ?? config?.extensions),
    });
    for (const [id, path, scope] of [
        ["profile", profileExtensionDirectory, "profile"] as const,
        ["project", projectExtensionDirectory, "project"] as const,
    ]) {
        setting({
            id: `extensions.${id}.directory`,
            group: EXTENSION_GROUP,
            label: `${id[0]?.toUpperCase() ?? id} extension directory`,
            description: "installed extension packages and their owned files",
            value: `${existing(path)} · directory`,
            location: path,
            scope,
            apply: "host/client restart",
            action: { kind: "raw", path, target: "directory" },
            searchText: `${id} extension directory package install files`,
        });
        const registryPath = join(join(path, ".."), "extensions.json");
        setting({
            id: `extensions.${id}.registry`,
            group: EXTENSION_GROUP,
            label: `${id[0]?.toUpperCase() ?? id} extension registry`,
            description: "enabled, disabled, and managed extension records",
            value: `${existing(registryPath)} · registry`,
            location: registryPath,
            scope,
            apply: "host/client restart",
            action: { kind: "raw", path: registryPath },
            searchText: `${id} extension registry enabled disabled managed`,
        });
    }
    rawProfileSetting({
        id: "config.hooks",
        label: "Tool hooks",
        description: "pre- and post-tool commands run from the profile hooks directory",
        path: "hooks",
        value: `${config?.hooks?.length ?? 0} hooks`,
        apply: "host restart",
        searchText: "hooks pre_tool_use post_tool_use protocol timeout",
        facts: config?.hooks?.slice(0, 8).map((hook, index) => [
            `Hook ${index + 1}`,
            `${hook.phase} · ${hook.argv[0] ?? "command missing"} · ${Math.max(0, hook.argv.length - 1)} argument(s) hidden · ${hook.protocol ?? "vera"}${hook.timeout_ms === undefined ? "" : ` · ${hook.timeout_ms}ms`}`,
        ] as const),
    });
    rawProfileSetting({
        id: "config.disabled_builtin_extensions",
        label: "Disabled built-in extensions",
        description: "built-in capabilities deliberately turned off",
        path: "disabled_builtin_extensions",
        value: listValue(config?.disabled_builtin_extensions, "none"),
        apply: "client/host restart",
    });
    rawProfileSetting({
        id: "config.disabled_prompt_contributions",
        label: "Disabled prompt contributions",
        description: "built-in or extension prompt additions turned off",
        path: "disabled_prompt_contributions",
        value: listValue(config?.disabled_prompt_contributions, "none"),
        apply: "new sessions",
    });
    setting({
        id: "tui.extension_preferences",
        group: EXTENSION_GROUP,
        label: "Extension-owned preferences",
        description: "client extension namespaces in the TUI preference file",
        value: "schema owned by installed extensions",
        location: `${tuiPath}#extensions`,
        scope: "profile and extension",
        apply: "client reload or extension-specific",
        action: { kind: "raw", path: tuiPath },
        searchText: "extension preferences keybindings client",
    });
    const extensionPreferences = tuiRecord?.extensions;
    if (
        extensionPreferences !== null
        && typeof extensionPreferences === "object"
        && !Array.isArray(extensionPreferences)
    ) {
        for (const [extensionId, namespace] of Object.entries(
            extensionPreferences,
        )) {
            if (
                namespace !== null
                && typeof namespace === "object"
                && !Array.isArray(namespace)
            ) {
                for (const [key, value] of Object.entries(namespace)) {
                    setting({
                        id: `tui.extension.${extensionId}.${key}`,
                        group: EXTENSION_GROUP,
                        label: `${extensionId}: ${key}`,
                        description: "opaque extension-owned preference; schema belongs to the extension",
                        value: formatExtensionValue(key, value),
                        location: `${tuiPath}#extensions.${extensionId}.${key}`,
                        scope: `profile · extension ${extensionId}`,
                        apply: "extension-specific; restart if required",
                        action: { kind: "raw", path: tuiPath },
                        searchText: `extension ${extensionId} ${key} preference`,
                    });
                }
            } else {
                setting({
                    id: `tui.extension.${extensionId}`,
                    group: EXTENSION_GROUP,
                    label: `${extensionId} extension preferences`,
                    description: "opaque extension-owned preference namespace",
                    value: formatExtensionValue(extensionId, namespace),
                    location: `${tuiPath}#extensions.${extensionId}`,
                    scope: `profile · extension ${extensionId}`,
                    apply: "extension-specific; restart if required",
                    action: { kind: "raw", path: tuiPath },
                    searchText: `extension ${extensionId} preferences`,
                });
            }
        }
    }

    setting({
        id: "config.tui",
        group: TUI_GROUP,
        label: "Transcript and composer layout",
        description: "padding, spacing, separators, and composer boundary colors",
        value: objectValue(config?.tui, "built-in layout"),
        location: `${configPath}#tui`,
        scope: "profile",
        apply: "client restart",
        action: { kind: "raw", path: configPath },
        searchText: "tui transcript composer padding spacing separator color",
        facts: tuiConfigFacts(config?.tui),
    });
    setting({
        id: "tui.theme",
        group: TUI_GROUP,
        label: "Theme",
        description: "colors used by this TUI",
        value: context.theme ?? safeTuiValue(
            () => loadTuiThemePreference(tuiPath),
            "default",
        ),
        location: `${tuiPath}#theme`,
        scope: "profile",
        apply: "immediately",
        action: { kind: "settings", target: "theme" },
        searchText: "colors palette appearance",
    });
    setting({
        id: "tui.animation",
        group: TUI_GROUP,
        label: "Activity animation",
        description: "visual treatment while Vera is working",
        value: safeTuiValue(
            () => loadTuiActivityAnimationPreference(tuiPath),
            "conveyor",
        ),
        location: `${tuiPath}#animation`,
        scope: "profile",
        apply: "next client start",
        action: { kind: "raw", path: tuiPath },
        searchText: "animation conveyor shimmer braille off",
    });
    setting({
        id: "tui.animation_interval_ms",
        group: TUI_GROUP,
        label: "Activity animation interval",
        description: "milliseconds between activity frames",
        value: valueOr(
            safeTuiValue(
                () => loadTuiActivityAnimationIntervalPreference(tuiPath),
                undefined,
            ),
            "default",
        ),
        location: `${tuiPath}#animation_interval_ms`,
        scope: "profile",
        apply: "next client start",
        action: { kind: "raw", path: tuiPath },
    });
    setting({
        id: "tui.animation_width",
        group: TUI_GROUP,
        label: "Activity animation width",
        description: "terminal columns used by activity frames",
        value: valueOr(
            safeTuiValue(
                () => loadTuiActivityAnimationWidthPreference(tuiPath),
                undefined,
            ),
            "default",
        ),
        location: `${tuiPath}#animation_width`,
        scope: "profile",
        apply: "next client start",
        action: { kind: "raw", path: tuiPath },
    });
    setting({
        id: "tui.keybindings",
        group: TUI_GROUP,
        label: "Requested keybindings",
        description: "stored remap requests; the live resolver may reject unknown, fixed, malformed, or colliding entries",
        value: `${Object.keys(safeTuiValue(
            () => loadTuiKeybindingOverlay(tuiPath),
            {},
        )).length} requested`,
        location: `${tuiPath}#keybindings`,
        scope: "profile",
        apply: "next client start",
        action: { kind: "raw", path: tuiPath },
        searchText: "keys chords remap bindings",
    });
    const keybindingOverlay = safeTuiValue(
        () => loadTuiKeybindingOverlay(tuiPath),
        {},
    );
    for (const [binding, chord] of Object.entries(keybindingOverlay)) {
        setting({
            id: `tui.keybindings.${binding}`,
            group: TUI_GROUP,
            label: `Requested keybinding: ${binding}`,
            description: "requested remap; the live resolver may ignore it",
            value: String(chord),
            location: `${tuiPath}#keybindings.${binding}`,
            scope: "profile",
            apply: "next client start",
            action: { kind: "raw", path: tuiPath },
            searchText: `${binding} ${String(chord)} key chord remap`,
        });
    }
    setting({
        id: "tui.sidebar",
        group: TUI_GROUP,
        label: "Workspace sidebar geometry",
        description: "docked state and widths saved by the TUI",
        value: `${safeTuiValue(
            () => loadTuiWorkspaceSidebarDocked(tuiPath),
            false,
        ) ? "docked" : "floating"} · ${safeTuiValue(
            () => loadTuiWorkspaceSidebarWidth(tuiPath),
            undefined,
        ) ?? "default"} cols`,
        location: `${tuiPath}#workspace_sidebar_docked / workspace_sidebar_width`,
        scope: "profile",
        apply: "immediately",
        action: { kind: "raw", path: tuiPath },
        searchText: "sidebar workspace rail width docked",
        facts: [
            ["Sidebar width", valueOr(
                safeTuiValue(() => loadTuiSidebarWidth(tuiPath), undefined),
                "default",
            )],
            ["Workspace width", valueOr(
                safeTuiValue(
                    () => loadTuiWorkspaceSidebarWidth(tuiPath),
                    undefined,
                ),
                "default",
            )],
            ["Docked", safeTuiValue(
                () => loadTuiWorkspaceSidebarDocked(tuiPath),
                false,
            ) ? "yes" : "no"],
        ],
    });
    setting({
        id: "tui.sidebar_width",
        group: TUI_GROUP,
        label: "Transcript sidebar width",
        description: "width of the conversation-side working-set rail",
        value: valueOr(
            safeTuiValue(() => loadTuiSidebarWidth(tuiPath), undefined),
            "default",
        ),
        location: `${tuiPath}#sidebar_width`,
        scope: "profile",
        apply: "immediately",
        action: {
            kind: "readonly",
            reason: "Resize the conversation sidebar in the TUI; it owns this preference.",
        },
        searchText: "sidebar width rail resize",
    });
    setting({
        id: "tui.shared_session_groups",
        group: STATE_GROUP,
        label: "Shared session groups",
        description: "pairs of sessions kept together in the workspace rail",
        value: `${safeTuiValue(
            () => loadTuiSharedSessionGroups(tuiPath),
            [],
        ).length} groups`,
        location: `${tuiPath}#shared_session_groups`,
        scope: "profile",
        apply: "next client start",
        action: {
            kind: "readonly",
            reason: "The workspace rail owns session grouping. Use that TUI surface to change it.",
        },
        searchText: "workspace groups paired sessions rail",
    });
    setting({
        id: "tui.pinned_session_ids",
        group: STATE_GROUP,
        label: "Pinned sessions",
        description: "sessions kept at the top of the workspace rail",
        value: `${safeTuiValue(
            () => loadTuiPinnedSessionIds(tuiPath),
            [],
        ).length} pinned`,
        location: `${tuiPath}#pinned_session_ids`,
        scope: "profile",
        apply: "immediately",
        action: {
            kind: "readonly",
            reason: "The workspace rail owns pinned sessions. Use its pin action to change them.",
        },
        searchText: "pinned sessions workspace rail",
    });
    setting({
        id: "tui.persisted_agent_panes",
        group: STATE_GROUP,
        label: "Persisted agent panes",
        description: "saved paired agent panes restored by the TUI",
        value: `${validPersistedAgentPaneCount(tuiRecord?.persisted_agent_panes)} panes`,
        location: `${tuiPath}#persisted_agent_panes`,
        scope: "profile",
        apply: "next client start",
        action: {
            kind: "readonly",
            reason: "Pane persistence is generated by the workspace surface, not an editable setting.",
        },
        searchText: "agent pane sidebar restore workspace",
    });
    setting({
        id: "tui.model_presets",
        group: STATE_GROUP,
        label: "Legacy model presets",
        description: "older saved model and effort slots retained for migration",
        value: `${count(tuiRecord?.model_presets)} slots`,
        location: `${tuiPath}#model_presets or extensions.vera.model-presets`,
        scope: "profile",
        apply: "migration managed by Vera",
        action: { kind: "raw", path: tuiPath },
        searchText: "quickslots presets model effort migration",
    });
    setting({
        id: "tui.favorite_pairs",
        group: STATE_GROUP,
        label: "Legacy favorite pairs",
        description: "old model favorites retained for backward-compatible reads",
        value: `${count(tuiRecord?.favorite_pairs)} entries`,
        location: `${tuiPath}#favorite_pairs`,
        scope: "profile",
        apply: "migration managed by Vera",
        action: {
            kind: "readonly",
            reason: "This legacy block is retained for migration and is not a live settings control.",
        },
        searchText: "favorite pairs legacy migration model effort",
    });
    setting({
        id: "tui.favorite_pairs_migrated",
        group: STATE_GROUP,
        label: "Favorite migration marker",
        description: "version marker for the one-time preset migration",
        value: valueOr(tuiRecord?.favorite_pairs_migrated, "not migrated"),
        location: `${tuiPath}#favorite_pairs_migrated`,
        scope: "profile",
        apply: "managed by Vera",
        action: {
            kind: "readonly",
            reason: "Vera owns this migration marker; do not edit it by hand.",
        },
        searchText: "favorites migration marker legacy",
    });

    rawProfileSetting({
        id: "config.experimental.inbox",
        label: "Experimental inbox",
        description: "enable the optional agent inbox subsystem",
        path: "experimental.inbox",
        value: config?.experimental?.inbox === true ? "on" : "off",
        apply: "host restart",
        searchText: "experimental inbox",
    });
    setting({
        id: "config.inbox",
        group: WORKSPACE_GROUP,
        label: "Profile inbox admission",
        description: "source families allowed to deliver into this profile",
        value: listValue(config?.inbox?.admit, "none"),
        location: `${configPath}#inbox.admit`,
        scope: "profile",
        apply: "next host read",
        action: { kind: "raw", path: configPath },
        searchText: "inbox admit source family",
    });
    const projectInbox = readProjectInboxAdmission(projectConfigPath);
    setting({
        id: "project.inbox",
        group: WORKSPACE_GROUP,
        label: "Project inbox admission",
        description: "project additions to the profile's inbox families",
        value: projectConfigRecord.error === undefined
            ? listValue(projectInbox, "none")
            : "not available · project config read error",
        location: `${projectConfigPath}#inbox.admit`,
        scope: "project",
        apply: "next host read",
        action: { kind: "raw", path: projectConfigPath },
        searchText: "project inbox admit source family",
    });
    const spawnConsentPath = join(profilePath, "spawn-consent.json");
    const spawnConsent = readSpawnConsent(spawnConsentPath);
    setting({
        id: "state.spawn_consent",
        group: STATE_GROUP,
        label: "Inbox spawn consent",
        description: "whether an inbox event may create a new session",
        value: spawnConsent.confirmedAt === undefined
            ? "not confirmed"
            : `confirmed ${spawnConsent.confirmedAt}`,
        location: `${spawnConsentPath}#spawn_on_event.confirmed_at`,
        scope: "profile security state",
        apply: "immediately",
        action: {
            kind: "readonly",
            reason: "This is security-managed state, not ordinary configuration. Confirm or revoke inbox spawning through the inbox consent flow; delete the file to revoke before the next event.",
        },
        searchText: "inbox spawn consent confirm revoke security",
        facts: spawnConsent.error === undefined
            ? undefined
            : [["Read error", spawnConsent.error]],
    });
    setting({
        id: "agents.definitions",
        group: WORKSPACE_GROUP,
        label: "Agent definitions",
        description: "profile and project agents, including editable default pairs",
        value: "profile and project files",
        location: `${join(profilePath, "agents")} and ${join(context.projectRoot, ".vera", "agents")}`,
        scope: "profile and project",
        apply: "next agent/session read",
        action: {
            kind: "readonly",
            reason: "The agent picker edits the default pair only. Edit the owning agent Markdown files for tools, skills, posture, access, nudges, and instructions.",
        },
        searchText: "agents definitions default pair instructions",
    });
    setting({
        id: "agents.default_pair",
        group: WORKSPACE_GROUP,
        label: "Agent default model pair",
        description: "model and reasoning pair saved by the Agents picker",
        value: "open Agents picker",
        location: `${join(profilePath, "agents")} and ${join(context.projectRoot, ".vera", "agents")}#default_pair`,
        scope: "profile and project",
        apply: "next agent/session read",
        action: { kind: "settings", target: "agent" },
        searchText: "agent default pair model reasoning",
    });
    for (const [id, label, path, scope] of [
        ["agents.profile", "Profile agent definition files", join(profilePath, "agents"), "profile"] as const,
        ["agents.project", "Project agent definition files", join(context.projectRoot, ".vera", "agents"), "project"] as const,
    ]) {
        setting({
            id,
            group: WORKSPACE_GROUP,
            label,
            description: "Markdown frontmatter and instructions for tools, skills, posture, access, and default pair",
            value: `${existing(path)} · edit the files in this directory`,
            location: path,
            scope,
            apply: "next agent/session read",
            action: { kind: "raw", path, target: "directory" },
            searchText: "agent tools skills posture forbidden_access context nudges instructions",
        });
    }
    setting({
        id: "content.skills",
        group: WORKSPACE_GROUP,
        label: "Skills and skill packages",
        description: "system, profile, and project SKILL.md content loaded into prompts",
        value: "content surface · not a settings schema",
        location: `${join(profilePath, "skills")} and ${join(context.projectRoot, ".vera", "skills")}`,
        scope: "profile and project",
        apply: "next session read",
        action: {
            kind: "readonly",
            reason: "Edit the skill package files themselves; skills are content, not arbitrary config keys.",
        },
        searchText: "skills SKILL.md package prompt content",
    });
    setting({
        id: "content.instructions",
        group: WORKSPACE_GROUP,
        label: "Project instructions",
        description: "AGENTS.md and AGENTS.local.md files that shape project context",
        value: "content surface · not a settings schema",
        location: `${join(context.projectRoot, "AGENTS.md")} / ${join(context.projectRoot, "AGENTS.local.md")} and parents`,
        scope: "project",
        apply: "next session read",
        action: {
            kind: "readonly",
            reason: "Edit the instruction files in the project; Vera does not treat their prose as settings.",
        },
        searchText: "AGENTS.md instructions project context content",
    });
    setting({
        id: "content.memory",
        group: WORKSPACE_GROUP,
        label: "User and project memory",
        description: "durable Markdown memory read into context by scope",
        value: "content surface · not a settings schema",
        location: `${join(profilePath, "memory")} and project memory under the profile`,
        scope: "profile and project",
        apply: "next session read",
        action: {
            kind: "readonly",
            reason: "Use Vera's memory tools or edit the Markdown topics; memory content is not a settings lever.",
        },
        searchText: "memory markdown durable context content",
    });

    const activeProfile = safeProfileName(environment);
    const home = environment[VERA_HOME_ENV]?.trim() || join(homedir(), ".vera");
    const runtime = environment[VERA_RUNTIME_DIR_ENV]?.trim()
        || join(home, "profiles", activeProfile, "runtime");
    const launchOverride = (input: {
        readonly id: string;
        readonly label: string;
        readonly flag: string;
        readonly description: string;
        readonly apply: string;
        readonly searchText?: string;
    }): void => {
        const current = input.flag === "--bare"
            ? context.startupProfile === "bare"
            ? "active for this session"
            : context.startupProfile === undefined
            ? "current session not identified"
            : "not active for this session"
            : input.flag === "--prompt-only"
            ? context.startupProfile === "prompt_only"
            ? "active for this session"
            : context.startupProfile === undefined
            ? "current session not identified"
            : "not active for this session"
            : "one-shot override; not a durable setting";
        setting({
            id: input.id,
            group: LAUNCH_GROUP,
            label: input.label,
            description: input.description,
            value: current,
            location: input.flag,
            scope: "launch",
            apply: input.apply,
            action: {
                kind: "readonly",
                reason: `Supply ${input.flag} when launching Vera; it is not changed from this running client.`,
            },
            searchText: input.searchText ?? input.flag,
        });
    };
    launchOverride({
        id: "launch.bare",
        label: "Bare startup",
        flag: "--bare",
        description: "skip model extensions, project guidance, memory, and scratch prompt state",
        apply: "next client start",
        searchText: "bare startup prompt context",
    });
    launchOverride({
        id: "launch.prompt_only",
        label: "Prompt-only startup",
        flag: "--prompt-only",
        description: "send only Vera's identity prompt and user message, with no tools",
        apply: "next client start",
        searchText: "prompt only no tools startup",
    });
    launchOverride({
        id: "launch.permission_mode",
        label: "Launch permission override",
        flag: "--permission-mode MODE",
        description: "choose the permission mode for one launched session",
        apply: "next session",
        searchText: "permission mode launch flag",
    });
    launchOverride({
        id: "launch.model",
        label: "Launch model override",
        flag: "--model MODEL",
        description: "choose a shortlisted model for one launched session",
        apply: "next session",
        searchText: "model launch flag default",
    });
    launchOverride({
        id: "launch.effort",
        label: "Launch reasoning override",
        flag: "--effort LEVEL",
        description: "choose reasoning effort for one launched session",
        apply: "next session",
        searchText: "effort reasoning launch flag",
    });
    setting({
        id: "launch.profile",
        group: LAUNCH_GROUP,
        label: "Active profile",
        description: "configuration and durable state selected for this client",
        value: activeProfile,
        location: `${VERA_PROFILE_ENV} or --profile NAME`,
        scope: "launch",
        apply: "next client start",
        action: {
            kind: "readonly",
            reason: "Profile selection happens before Vera starts. Relaunch with --profile NAME.",
        },
        searchText: "profile VERA_PROFILE --profile",
    });
    setting({
        id: "launch.home",
        group: LAUNCH_GROUP,
        label: "Vera home",
        description: "machine and profile storage root",
        value: home,
        location: VERA_HOME_ENV,
        scope: "launch",
        apply: "next client start",
        action: {
            kind: "readonly",
            reason: "Set VERA_HOME before launching Vera; the running client cannot move its storage tier.",
        },
    });
    const arcConfig = environment.ARC_CONFIG?.trim()
        || join(homedir(), ".config", "arc", "config.toml");
    setting({
        id: "launch.arc_config",
        group: LAUNCH_GROUP,
        label: "Arc identity config",
        description: "Arc node identity and inbox authentication file; token values are never shown",
        value: arcConfig,
        location: "ARC_CONFIG",
        scope: "launch",
        apply: "next host start",
        action: {
            kind: "readonly",
            reason: "Set ARC_CONFIG before launching Vera; the Arc file owns identity and authentication secrets.",
        },
        searchText: "ARC_CONFIG Arc identity inbox authentication token",
    });
    setting({
        id: "launch.runtime",
        group: LAUNCH_GROUP,
        label: "Runtime directory",
        description: "resident host locks, sockets, and runtime logs",
        value: runtime,
        location: VERA_RUNTIME_DIR_ENV,
        scope: "launch",
        apply: "next host start",
        action: {
            kind: "readonly",
            reason: "Set VERA_RUNTIME_DIR before launching the host; restart the resident host afterward.",
        },
    });
    setting({
        id: "launch.pool_file",
        group: LAUNCH_GROUP,
        label: "Pool file override",
        description: "alternate user pool path used by this process",
        value: environment.VERA_POOL_FILE?.trim() || userPoolPath,
        location: "VERA_POOL_FILE",
        scope: "launch",
        apply: "next client start",
        action: {
            kind: "readonly",
            reason: "Set VERA_POOL_FILE before launching Vera; the catalog cannot change a process environment.",
        },
        searchText: "pool VERA_POOL_FILE",
    });
    setting({
        id: "launch.extensions",
        group: LAUNCH_GROUP,
        label: "Extension list override",
        description: "comma-separated extension directories replacing config extensions",
        value: environment.VERA_EXTENSIONS?.trim() || "not set",
        location: "VERA_EXTENSIONS",
        scope: "launch",
        apply: "host restart",
        action: {
            kind: "readonly",
            reason: "Set VERA_EXTENSIONS before launching the host; it replaces the configured list.",
        },
        searchText: "extensions VERA_EXTENSIONS",
    });
    setting({
        id: "launch.color",
        group: LAUNCH_GROUP,
        label: "Color output override",
        description: "standard terminal color suppression for CLI output",
        value: environment.NO_COLOR === undefined ? "enabled" : "NO_COLOR set",
        location: "NO_COLOR",
        scope: "launch",
        apply: "next command",
        action: {
            kind: "readonly",
            reason: "NO_COLOR is read from the launch environment, not edited in Vera.",
        },
    });
    setting({
        id: "launch.log_level",
        group: LAUNCH_GROUP,
        label: "Diagnostic log level",
        description: "extra event-stream detail for troubleshooting",
        value: environment.VERA_LOG_LEVEL?.trim() || "info",
        location: "VERA_LOG_LEVEL",
        scope: "launch",
        apply: "next host start",
        action: {
            kind: "readonly",
            reason: "Set VERA_LOG_LEVEL before launching the host; it is a diagnostic environment override.",
        },
        searchText: "logs debug VERA_LOG_LEVEL",
    });
    for (const [id, variable, label, description] of [
        ["launch.visual", "VISUAL", "Preferred visual editor", "program used for raw settings files"],
        ["launch.editor", "EDITOR", "Fallback editor", "editor used when VISUAL is not set"],
    ] as const) {
        setting({
            id,
            group: LAUNCH_GROUP,
            label,
            description,
            value: environment[variable]?.trim() || "system fallback",
            location: variable,
            scope: "launch",
            apply: "next editor open",
            action: {
                kind: "readonly",
                reason: `Set ${variable} before opening a file; the editor choice is owned by the launch environment.`,
            },
            searchText: `${variable} editor configure file`,
        });
    }

    setting({
        id: "state.tui-managed",
        group: STATE_GROUP,
        label: "TUI-managed state",
        description: "recent session pointer and other generated navigation state",
        value: `${tuiPath} · not a settings schema`,
        location: `${tuiPath}#recent_session_id / shared_session_groups / pinned_session_ids / persisted_agent_panes`,
        scope: "profile",
        apply: "managed by the TUI",
        action: {
            kind: "readonly",
            reason: "These values are generated navigation state. Use the TUI that owns them instead of editing them as settings.",
        },
        searchText: "recent session pinned panes state",
    });
    setting({
        id: "state.runtime",
        group: STATE_GROUP,
        label: "Host and session state",
        description: "resident host, session transcripts, caches, and event logs",
        value: "managed files under the active profile",
        location: runtime,
        scope: "profile runtime",
        apply: "managed by Vera",
        action: {
            kind: "readonly",
            reason: "Runtime and conversation files are durable state, not configuration levers.",
        },
        searchText: "runtime host sessions cache event log",
    });
    const tipsStatePath = join(profilePath, "tips.json");
    setting({
        id: "state.tips-history",
        group: STATE_GROUP,
        label: "Tip history",
        description: "launch counter and dismissed discovery-tip history",
        value: `${existing(tipsStatePath)} · generated state`,
        location: tipsStatePath,
        scope: "profile",
        apply: "managed by the TUI",
        action: {
            kind: "readonly",
            reason: "Tip history is generated convenience state. Use the tips setting for visibility; do not edit this counter as configuration.",
        },
        searchText: "tips history launches dismissed state",
    });

    if (tuiRecordResult.error !== undefined) {
        entries.push({
            id: "tui.error",
            group: TUI_GROUP,
            label: "TUI preference read error",
            description: tuiRecordResult.error,
            value: "not parsed",
            location: tuiPath,
            scope: "profile",
            apply: "fix file and restart client",
            action: { kind: "raw", path: tuiPath },
            searchText: "tui preferences invalid JSON restart",
            facts: [["Recovery", "Fix the file, then restart the client."]],
        });
    }
    if (projectConfigRecord.error !== undefined) {
        entries.push({
            id: "project.config.error",
            group: WORKSPACE_GROUP,
            label: "Project config read error",
            description: projectConfigRecord.error,
            value: "not parsed",
            location: projectConfigPath,
            scope: "project",
            apply: "fix file and reopen",
            action: { kind: "raw", path: projectConfigPath },
            searchText: "project config invalid JSON inbox",
            facts: [["Recovery", "Fix or remove the project config, then reopen the workspace."]],
        });
    }
    for (const key of unknownConfigKeys(
        projectConfigRecord.value,
        PROJECT_CONFIG_ROOT_KEYS,
    )) {
        entries.push({
            id: `project.config.unknown.${key}`,
            group: WORKSPACE_GROUP,
            label: `Unsupported project config field: ${key}`,
            description: "project config supports inbox admission only; this field has no effect",
            value: "no effect",
            location: `${projectConfigPath}#${key}`,
            scope: "project",
            apply: "not applicable",
            action: { kind: "raw", path: projectConfigPath },
            searchText: `project unknown unsupported ${key}`,
            facts: [["Recovery", "Remove it or keep only the supported project inbox block."]],
        });
    }

    const configError = context.configError ?? configRecord.error;
    if (configError !== undefined) {
        entries.push({
            id: "config.error",
            group: PROFILE_GROUP,
            label: "Profile config read error",
            description: configError,
            value: "not parsed",
            location: configPath,
            scope: "profile",
            apply: "fix file and restart",
            action: {
                kind: "raw",
                path: configPath,
            },
            searchText: "config error invalid JSON restart",
            facts: [["Recovery", "Fix or remove the file, then restart Vera."]],
        });
    }

    for (const key of unknownConfigKeys(rawConfig)) {
        entries.push({
            id: `config.unknown.${key}`,
            group: PROFILE_GROUP,
            label: `Unsupported config field: ${key}`,
            description: "unknown field; Vera does not apply it",
            value: "no effect",
            location: `${configPath}#${key}`,
            scope: "profile",
            apply: "not applicable",
            action: {
                kind: "raw",
                path: configPath,
            },
            searchText: `unknown unsupported ${key}`,
            facts: [["Recovery", "Remove it or confirm the spelling in Vera's supported settings."]],
        });
    }
    for (const field of unknownNestedConfigFields(rawConfig, "profile")) {
        entries.push({
            id: `config.unknown.${field.path.replaceAll(".", "_")}`,
            group: PROFILE_GROUP,
            label: `Unsupported config field: ${field.path}`,
            description: "nested field is not read by Vera's profile loader",
            value: "no effect",
            location: `${configPath}#${field.path}`,
            scope: "profile",
            apply: "not applicable",
            action: { kind: "raw", path: configPath },
            searchText: `unknown unsupported ${field.path}`,
            facts: [["Recovery", "Remove it or confirm the spelling in Vera's supported settings."]],
        });
    }
    for (const field of unknownNestedConfigFields(projectConfigRecord.value, "project")) {
        entries.push({
            id: `project.config.unknown.${field.path.replaceAll(".", "_")}`,
            group: WORKSPACE_GROUP,
            label: `Unsupported project config field: ${field.path}`,
            description: "nested field is not read by the project config loader",
            value: "no effect",
            location: `${projectConfigPath}#${field.path}`,
            scope: "project",
            apply: "not applicable",
            action: { kind: "raw", path: projectConfigPath },
            searchText: `project unknown unsupported ${field.path}`,
            facts: [["Recovery", "Remove it or keep only the supported project inbox block."]],
        });
    }
    for (const key of unknownTuiKeys(tuiRecord)) {
        entries.push({
            id: `tui.unknown.${key}`,
            group: TUI_GROUP,
            label: `Unsupported TUI preference: ${key}`,
            description: "unknown field is ignored by the TUI preference loader",
            value: "no effect",
            location: `${tuiPath}#${key}`,
            scope: "profile",
            apply: "not applicable",
            action: { kind: "raw", path: tuiPath },
            searchText: `tui unknown unsupported ${key}`,
            facts: [["Recovery", "Remove it or confirm the spelling in TUI preferences."]],
        });
    }
    for (const field of invalidTuiFields(tuiRecord, tuiPath)) {
        entries.push({
            id: `tui.invalid.${field.key}`,
            group: TUI_GROUP,
            label: `Rejected TUI preference: ${field.key}`,
            description: "the stored value failed TUI validation and was replaced",
            value: `effective ${field.effective}`,
            location: `${tuiPath}#${field.key}`,
            scope: "profile",
            apply: "fix file and restart client",
            action: { kind: "raw", path: tuiPath },
            searchText: `tui invalid rejected ${field.key}`,
            facts: [["Stored", field.stored], ["Effective", field.effective]],
        });
    }

    return entries;
}

function profileDirectory(
    environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
    const home = environment[VERA_HOME_ENV]?.trim()
        || join(homedir(), ".vera");
    const profile = safeProfileName(environment);
    return join(home, "profiles", profile);
}

function machineDirectory(
    environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
    const home = environment[VERA_HOME_ENV]?.trim()
        || join(homedir(), ".vera");
    return join(home, "machine");
}

function formatSessionModel(session: NonNullable<ConfigurationCatalogContext["currentSession"]>): string {
    const model = session.provider === undefined
        ? session.model
        : `${session.provider}/${session.model}`;
    return session.reasoningEffort === undefined
        ? model
        : `${model} (${session.reasoningEffort})`;
}

function objectFacts(
    value: unknown,
    keys: readonly string[],
): readonly (readonly [string, string])[] | undefined {
    if (value === undefined || value === null || typeof value !== "object") {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    return keys.map((key) => [key, formatCatalogValue(record[key], key)] as const);
}

function extensionFacts(
    extensions: readonly VeraExtensionConfig[] | undefined,
): readonly (readonly [string, string])[] | undefined {
    if (extensions === undefined || extensions.length === 0) return undefined;
    return extensions.slice(0, 8).map((extension) => [
        extension.path,
        extension.enabled ? "enabled · config values not shown" : "disabled",
    ] as const);
}

function tuiConfigFacts(
    tui: VeraConfig["tui"],
): readonly (readonly [string, string])[] | undefined {
    if (tui === undefined) return undefined;
    const facts: (readonly [string, string])[] = [];
    for (const [key, value] of Object.entries(tui.transcript ?? {})) {
        facts.push([`transcript.${key}`, String(value)]);
    }
    for (const [key, value] of Object.entries(tui.composer ?? {})) {
        facts.push([`composer.${key}`, String(value)]);
    }
    return facts.length === 0 ? undefined : facts;
}

function formatCatalogValue(value: unknown, key?: string): string {
    if (value === undefined) return "not set";
    if (value === null) return "null";
    if (typeof value === "string") {
        if (isSensitiveFieldName(key)) return "set · value hidden";
        return isUrlLike(value) ? redactUrl(value) : value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    if (Array.isArray(value)) return `${value.length} entries`;
    if (typeof value === "object") return `${Object.keys(value).length} configured`;
    return "configured";
}

function readJsonRecord(path: string): {
    readonly value?: Record<string, unknown>;
    readonly error?: string;
} {
    if (!existsSync(path)) return {};
    try {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return { error: "expected a JSON object" };
        }
        return { value: value as Record<string, unknown> };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

function unknownConfigKeys(
    record: Record<string, unknown> | undefined,
    knownKeys: readonly string[] = VERA_CONFIG_CATALOG_KEYS,
): readonly string[] {
    if (record === undefined) return [];
    const known = new Set(knownKeys);
    return Object.keys(record).filter((key) => !known.has(key)).sort();
}

const PROJECT_CONFIG_ROOT_KEYS = ["inbox"] as const;

interface UnknownConfigField {
    readonly path: string;
}

const KNOWN_CONFIG_NESTED_KEYS: Readonly<Record<string, readonly string[]>> = {
    fallback: ["model", "after_failures"],
    reviewer: [
        "provider",
        "model",
        "reasoning_effort",
        "fallback_provider",
        "fallback_model",
        "fallback_reasoning_effort",
        "timeout_ms",
        "two_tier",
        "escalation_provider",
        "escalation_model",
        "escalation_reasoning_effort",
    ],
    subagent: ["provider", "model", "reasoning_effort"],
    compaction: [
        "strategy",
        "models",
        "timeout_ms",
        "trigger_fraction",
        "trigger_tokens",
        "target_tokens",
        "retained_user_turns",
    ],
    experimental: ["inbox"],
    developer: [
        "enabled",
        "context_limit",
        "compaction_trigger_fraction",
        "post_compaction_target_fraction",
        "summary_word_cap",
    ],
    event_log: ["enabled"],
    tips: ["enabled"],
    tui: ["transcript", "composer"],
    inbox: ["admit"],
    "tui.transcript": [
        "padding_left",
        "padding_right",
        "activity_indent",
        "message_spacing",
        "tool_group_spacing",
        "separator_visible",
        "separator_spacing_before",
        "separator_spacing_after",
        "separator_color",
    ],
    "tui.composer": [
        "margin_horizontal",
        "padding_horizontal",
        "tip_indent",
        "boundary_color",
    ],
};

function unknownNestedConfigFields(
    record: Record<string, unknown> | undefined,
    scope: "profile" | "project",
): readonly UnknownConfigField[] {
    if (record === undefined) return [];
    const fields: UnknownConfigField[] = [];
    const scan = (path: string, value: unknown, keys: readonly string[]): void => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            return;
        }
        for (const key of Object.keys(value as Record<string, unknown>)) {
            if (!keys.includes(key)) {
                fields.push({ path: `${path}.${key}` });
            }
        }
    };

    // The project file deliberately has a much smaller contract than the
    // profile file. Scan only the block the project loader reads; a project
    // root typo is reported separately by unknownConfigKeys above.
    if (scope === "project") {
        scan("inbox", record.inbox, ["admit"]);
        return fields;
    }

    for (const [path, keys] of Object.entries(KNOWN_CONFIG_NESTED_KEYS)) {
        const value = path.split(".").reduce<unknown>((current, key) =>
            current !== null && typeof current === "object"
                ? (current as Record<string, unknown>)[key]
                : undefined, record);
        scan(path, value, keys);
    }

    const providers = record.providers;
    if (providers !== null && typeof providers === "object" && !Array.isArray(providers)) {
        for (const [id, value] of Object.entries(providers)) {
            scan(`providers.${id}`, value, [
                "protocol",
                "base_url",
                "credential",
                "api_key_env",
                "images",
                "max_tokens",
                "thinking",
            ]);
        }
    }
    const permissionModes = record.permission_modes ?? record.permission_profiles;
    if (
        permissionModes !== null
        && typeof permissionModes === "object"
        && !Array.isArray(permissionModes)
    ) {
        for (const [name, value] of Object.entries(permissionModes)) {
            scan(`permission_modes.${name}`, value, [
                "default",
                "reviewer_profile",
                "rules",
            ]);
        }
    }
    const reviewerProfiles = record.reviewer_profiles;
    if (
        reviewerProfiles !== null
        && typeof reviewerProfiles === "object"
        && !Array.isArray(reviewerProfiles)
    ) {
        for (const [name, value] of Object.entries(reviewerProfiles)) {
            scan(`reviewer_profiles.${name}`, value, [
                "model_route",
                "policy",
                "timeout_ms",
            ]);
        }
    }

    const models = record.models;
    if (Array.isArray(models)) {
        models.forEach((value, index) => {
            scan(`models.${index}`, value, [
                "name",
                "provider",
                "model",
                "reasoning_effort",
            ]);
        });
    }

    const hooks = record.hooks;
    if (Array.isArray(hooks)) {
        hooks.forEach((value, index) => {
            scan(`hooks.${index}`, value, [
                "phase",
                "argv",
                "protocol",
                "timeout_ms",
            ]);
        });
    }

    const extensions = record.extensions;
    if (Array.isArray(extensions)) {
        extensions.forEach((value, index) => {
            // `config` is intentionally opaque: the extension owns that
            // schema and the catalog must not guess which strings are secrets.
            scan(`extensions.${index}`, value, ["path", "enabled", "config"]);
        });
    }

    const assignments = record.model_assignments;
    if (assignments !== null && typeof assignments === "object" && !Array.isArray(assignments)) {
        const assignmentRecord = assignments as Record<string, unknown>;
        for (const [name, value] of Object.entries(assignmentRecord)) {
            if (name === "never_auto") continue;
            scan(`model_assignments.${name}`, value, [
                "model_route",
                "models",
                "label",
                "allow_self",
            ]);
            if (
                value !== null
                && typeof value === "object"
                && !Array.isArray(value)
                && Array.isArray((value as Record<string, unknown>).models)
            ) {
                ((value as Record<string, unknown>).models as unknown[]).forEach(
                    (model, index) => scan(`model_assignments.${name}.models.${index}`, model, [
                        "name",
                        "provider",
                        "model",
                        "reasoning_effort",
                    ]),
                );
            }
        }
        const exclusions = assignmentRecord.never_auto;
        if (exclusions !== null && typeof exclusions === "object" && !Array.isArray(exclusions)) {
            for (const [name, value] of Object.entries(exclusions)) {
                if (!Array.isArray(value)) continue;
                value.forEach((rule, index) => scan(
                    `model_assignments.never_auto.${name}.${index}`,
                    rule,
                    ["provider", "model"],
                ));
            }
        }
    }

    const permissionRoot = record.permission_modes !== undefined
        ? "permission_modes"
        : "permission_profiles";
    const permissionModeValues = record[permissionRoot];
    if (
        permissionModeValues !== null
        && typeof permissionModeValues === "object"
        && !Array.isArray(permissionModeValues)
    ) {
        for (const [name, value] of Object.entries(permissionModeValues)) {
            const modePath = `${permissionRoot}.${name}`;
            if (value === null || typeof value !== "object" || Array.isArray(value)) {
                continue;
            }
            const mode = value as Record<string, unknown>;
            const rules = mode.rules;
            if (!Array.isArray(rules)) continue;
            rules.forEach((rule, index) => {
                const rulePath = `${modePath}.rules.${index}`;
                scan(rulePath, rule, ["when", "then"]);
                if (
                    rule !== null
                    && typeof rule === "object"
                    && !Array.isArray(rule)
                ) {
                    scan(`${rulePath}.when`, (rule as Record<string, unknown>).when, [
                        "tool",
                        "verb",
                        "operation",
                        "path",
                        "path_glob",
                        "scope",
                        "executable",
                        "capability",
                        "path_scope",
                    ]);
                }
            });
        }
    }
    return fields.toSorted((left, right) => left.path.localeCompare(right.path));
}

const TUI_JSON_KEYS = [
    "theme",
    "animation",
    "recent_session_id",
    "animation_interval_ms",
    "animation_width",
    "sidebar_width",
    "workspace_sidebar_docked",
    "workspace_sidebar_width",
    "shared_session_groups",
    "pinned_session_ids",
    "persisted_agent_panes",
    "model_presets",
    "favorite_pairs",
    "favorite_pairs_migrated",
    "keybindings",
    "extensions",
] as const;

function unknownTuiKeys(
    record: Record<string, unknown> | undefined,
): readonly string[] {
    if (record === undefined) return [];
    const known = new Set<string>(TUI_JSON_KEYS);
    return Object.keys(record).filter((key) => !known.has(key)).sort();
}

interface InvalidTuiField {
    readonly key: string;
    readonly stored: string;
    readonly effective: string;
}

function invalidTuiFields(
    record: Record<string, unknown> | undefined,
    path: string,
): readonly InvalidTuiField[] {
    if (record === undefined) return [];
    const result: InvalidTuiField[] = [];
    const add = (
        key: string,
        valid: boolean,
        effective: unknown,
    ): void => {
        if (!Object.hasOwn(record, key) || valid) return;
        result.push({
            key,
            stored: formatCatalogValue(record[key], key),
            effective: formatCatalogValue(effective, key),
        });
    };
    add("theme", isTuiThemeName(record.theme), safeTuiValue(
        () => loadTuiThemePreference(path), "default",
    ));
    add("animation", isTuiActivityAnimation(record.animation), safeTuiValue(
        () => loadTuiActivityAnimationPreference(path), "conveyor",
    ));
    add("animation_interval_ms", isBoundedInteger(record.animation_interval_ms, 32, 2_000), safeTuiValue(
        () => loadTuiActivityAnimationIntervalPreference(path), undefined,
    ));
    add("animation_width", isBoundedInteger(record.animation_width, 2, 15), safeTuiValue(
        () => loadTuiActivityAnimationWidthPreference(path), undefined,
    ));
    add("sidebar_width", isBoundedInteger(record.sidebar_width, 20, 400), safeTuiValue(
        () => loadTuiSidebarWidth(path), undefined,
    ));
    add("workspace_sidebar_docked", typeof record.workspace_sidebar_docked === "boolean", safeTuiValue(
        () => loadTuiWorkspaceSidebarDocked(path), false,
    ));
    add("workspace_sidebar_width", isBoundedInteger(record.workspace_sidebar_width, 20, 400), safeTuiValue(
        () => loadTuiWorkspaceSidebarWidth(path), undefined,
    ));
    add("favorite_pairs_migrated", typeof record.favorite_pairs_migrated === "number"
        && Number.isInteger(record.favorite_pairs_migrated),
        typeof record.favorite_pairs_migrated === "number"
            && Number.isInteger(record.favorite_pairs_migrated)
            ? record.favorite_pairs_migrated
            : undefined);
    for (const [key, expected] of [
        ["keybindings", "object"],
        ["extensions", "object"],
        ["shared_session_groups", "array"],
        ["pinned_session_ids", "array"],
        ["persisted_agent_panes", "array"],
        ["model_presets", "array"],
        ["favorite_pairs", "array"],
    ] as const) {
        const value = record[key];
        const valid = expected === "array"
            ? Array.isArray(value)
            : value !== null && typeof value === "object" && !Array.isArray(value);
        add(key, valid, value);
    }
    return result;
}

function validPersistedAgentPaneCount(value: unknown): number {
    if (!Array.isArray(value)) return 0;
    const usedMainIds = new Set<string>();
    let count = 0;
    for (const candidate of value) {
        if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
            continue;
        }
        const mainAgentId = Reflect.get(candidate, "main_agent_id");
        const sidebarAgentId = Reflect.get(candidate, "sidebar_agent_id");
        const owner = Reflect.get(candidate, "owner");
        const mention = Reflect.get(candidate, "mention");
        const statusLabel = Reflect.get(candidate, "status_label");
        if (
            typeof mainAgentId !== "string" || mainAgentId.length === 0
            || typeof sidebarAgentId !== "string" || sidebarAgentId.length === 0
            || mainAgentId === sidebarAgentId
            || typeof owner !== "string" || owner.length === 0
            || (mention !== undefined
                && (typeof mention !== "string" || mention.length === 0))
            || (statusLabel !== undefined
                && (typeof statusLabel !== "string" || statusLabel.length === 0))
            || usedMainIds.has(mainAgentId)
        ) {
            continue;
        }
        usedMainIds.add(mainAgentId);
        count += 1;
    }
    return count;
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): boolean {
    return typeof value === "number"
        && Number.isInteger(value)
        && value >= minimum
        && value <= maximum;
}

function isUrlLike(value: string): boolean {
    return /^https?:\/\//i.test(value);
}

function isSensitiveFieldName(key: string | undefined): boolean {
    if (key === undefined || key.endsWith("_env")) return false;
    return /(?:token|secret|password|passphrase|api[_-]?key|auth|credential|cookie|bearer|private[_-]?key)/i.test(key);
}

function redactUrl(value: string): string {
    try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        for (const key of [...url.searchParams.keys()]) {
            if (/(?:key|token|secret|signature|sig|password|auth|credential)/i.test(key)) {
                url.searchParams.set(key, "[redacted]");
            }
        }
        if (url.hash.length > 0) url.hash = "#[redacted]";
        return url.toString();
    } catch {
        return value
            .replace(/:\/\/[^/@]+@/u, "://[redacted]@")
            .replace(/([?&](?:key|token|secret|signature|sig|password|auth)=)[^&]*/giu, "$1[redacted]");
    }
}

function formatExtensionValue(key: string, value: unknown): string {
    // Extension config is an extension-owned schema. We cannot know whether a
    // string is a secret, so never echo opaque extension strings in the catalog.
    if (typeof value === "string") return "set · value hidden";
    return formatCatalogValue(value, key);
}

function formatAssignmentValue(value: unknown): string {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return formatCatalogValue(value);
    }
    const record = value as Record<string, unknown>;
    const models = Array.isArray(record.models)
        ? `${record.models.length} models`
        : record.model === undefined
        ? "inherits"
        : `${record.provider === undefined ? "" : `${record.provider}/`}${record.model}`;
    return record.reasoning_effort === undefined
        ? models
        : `${models} · ${record.reasoning_effort}`;
}

function readSpawnConsent(path: string): {
    readonly confirmedAt?: string;
    readonly error?: string;
} {
    const record = readJsonRecord(path);
    if (record.error !== undefined) return { error: record.error };
    const spawn = record.value?.spawn_on_event;
    if (spawn === undefined) return {};
    if (spawn === null || typeof spawn !== "object" || Array.isArray(spawn)) {
        return { error: "spawn_on_event must be an object" };
    }
    const confirmedAt = (spawn as Record<string, unknown>).confirmed_at;
    return typeof confirmedAt === "string" && !Number.isNaN(Date.parse(confirmedAt))
        ? { confirmedAt }
        : { error: "spawn_on_event.confirmed_at is missing or invalid" };
}

function hasRawKey(
    record: Record<string, unknown> | undefined,
    key: string,
): boolean {
    return record !== undefined && Object.hasOwn(record, key);
}

function safeProfileName(
    environment: Readonly<Record<string, string | undefined>>,
): string {
    try {
        return veraProfileName(environment);
    } catch {
        return environment[VERA_PROFILE_ENV]?.trim() || "invalid profile";
    }
}

function safeTuiValue<T>(
    read: () => T,
    fallback: T,
): T {
    try {
        return read();
    } catch {
        return fallback;
    }
}

function readProjectInboxAdmission(path: string): readonly string[] {
    const record = readJsonRecord(path).value;
    const inbox = record?.inbox;
    if (typeof inbox !== "object" || inbox === null || Array.isArray(inbox)) {
        return [];
    }
    const admit = (inbox as Record<string, unknown>).admit;
    return parseInboxAdmissionList(admit) ?? [];
}
