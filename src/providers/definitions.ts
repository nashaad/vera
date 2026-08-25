import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PROVIDER_DEFINITION_SCHEMA_VERSION = 1;

export type ProviderAccess = "subscription" | "api_key" | "local";
export type ProviderCredential =
    | "oauth"
    | "api_key"
    | "api_key_optional"
    | "none";
export type ProviderProtocol =
    | "openai-chat"
    | "anthropic-messages"
    | "contributed";
export type ProviderDiscoveryMode = "models" | "cache" | "none";
export type DiscoveryCredential = "required" | "optional" | "none";

export interface ProviderCompatibilityLayers {
    readonly request?: readonly string[];
    readonly response?: readonly string[];
    readonly error?: readonly string[];
    readonly effort?: readonly string[];
    readonly catalog?: readonly string[];
}

export interface ProviderDiscoveryDefinition {
    readonly mode: ProviderDiscoveryMode;
    readonly path: string;
    readonly credential: DiscoveryCredential;
}

export interface ProviderDefinition {
    readonly schema_version: typeof PROVIDER_DEFINITION_SCHEMA_VERSION;
    readonly order?: number;
    readonly id: string;
    readonly label: string;
    readonly short_label: string;
    readonly access: ProviderAccess;
    readonly credential: ProviderCredential;
    readonly hint?: string;
    readonly env_var?: string;
    readonly protocol: ProviderProtocol;
    readonly behavior_id?: string;
    readonly default_base_url: string;
    readonly fixed_endpoint?: boolean;
    readonly discovery: ProviderDiscoveryDefinition;
    readonly compatibility: ProviderCompatibilityLayers;
}

export interface ProviderDeclaration {
    readonly protocol: "openai-chat" | "anthropic-messages";
    readonly base_url: string;
    readonly credential: "api_key" | "none";
    readonly api_key_env?: string;
    readonly images?: boolean;
    readonly max_tokens?: number;
    readonly thinking?: "adaptive";
}

export interface ProviderResolutionInput {
    readonly providers?: Readonly<Record<string, ProviderDeclaration>>;
    readonly provider_endpoints?: Readonly<Record<string, string>>;
    readonly contributed?: readonly ProviderDefinition[];
}

export interface ResolvedProvider {
    readonly definition: ProviderDefinition;
    readonly id: string;
    readonly baseUrl: string;
    readonly source: "shipped" | "extension" | "profile";
    readonly custom: boolean;
    readonly declaration?: ProviderDeclaration;
}

const DEFINITION_DIRECTORY = join(import.meta.dir, "definitions");
const ALLOWED_LAYERS = new Set([
    "openai-chat",
    "openai-sse",
    "http-status",
    "cerebras-request-fields",
    "deepseek-thinking",
    "ollama-thinking",
    "codex-wire",
    "codex-stream",
    "codex-error",
    "openrouter-request-fields",
    "openrouter-stream",
    "openrouter-error",
]);

export function shippedProviderDefinitions(): readonly ProviderDefinition[] {
    return readdirSync(DEFINITION_DIRECTORY)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => parseProviderDefinition(
            JSON.parse(readFileSync(join(DEFINITION_DIRECTORY, name), "utf8")),
            `shipped provider ${name}`,
        ))
        .sort((left, right) => (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER));
}

export function shippedProviderIds(): readonly string[] {
    return shippedProviderDefinitions().map((definition) => definition.id);
}

export function resolveProviders(
    input: ProviderResolutionInput = {},
): readonly ResolvedProvider[] {
    const shipped = shippedProviderDefinitions();
    const byId = new Map<string, ResolvedProvider>();
    for (const definition of shipped) {
        addResolved(byId, {
            definition,
            id: definition.id,
            baseUrl: definition.default_base_url,
            source: "shipped",
            custom: false,
        });
    }
    for (const definition of input.contributed ?? []) {
        addResolved(byId, {
            definition,
            id: definition.id,
            baseUrl: definition.default_base_url,
            source: "extension",
            custom: false,
        });
    }
    for (const [id, declaration] of Object.entries(input.providers ?? {})) {
        if (byId.has(id)) {
            throw new Error(`Provider id ${id} is reserved by a shipped provider`);
        }
        const definition = declarationToDefinition(id, declaration);
        addResolved(byId, {
            definition,
            id,
            baseUrl: declaration.base_url,
            source: "profile",
            custom: true,
            declaration,
        });
    }
    for (const [id, endpoint] of Object.entries(input.provider_endpoints ?? {})) {
        const current = byId.get(id);
        if (current === undefined) {
            throw new Error(`Endpoint override names unknown provider ${id}`);
        }
        if (current.definition.fixed_endpoint === true) {
            throw new Error(`Provider ${id} has a fixed endpoint`);
        }
        byId.set(id, { ...current, baseUrl: endpoint });
    }
    return [...byId.values()];
}

export function providerDefinition(
    id: string,
): ProviderDefinition | undefined {
    return shippedProviderDefinitions().find((definition) => definition.id === id);
}

export function isFixedEndpointProvider(id: string): boolean {
    return providerDefinition(id)?.fixed_endpoint === true;
}

function addResolved(
    byId: Map<string, ResolvedProvider>,
    provider: ResolvedProvider,
): void {
    if (byId.has(provider.id)) {
        throw new Error(`Duplicate provider definition ${provider.id}`);
    }
    byId.set(provider.id, provider);
}

function declarationToDefinition(
    id: string,
    declaration: ProviderDeclaration,
): ProviderDefinition {
    return parseProviderDefinition({
        schema_version: 1,
        id,
        label: id,
        short_label: id,
        access: declaration.credential === "none" ? "local" : "api_key",
        credential: declaration.credential,
        hint: declaration.credential === "none"
            ? "configured endpoint, no account"
            : declaration.api_key_env === undefined
                ? "API key"
                : `API key or ${declaration.api_key_env}`,
        ...(declaration.api_key_env === undefined
            ? {}
            : { env_var: declaration.api_key_env }),
        protocol: declaration.protocol,
        default_base_url: declaration.base_url,
        discovery: { mode: "models", path: "/models", credential: declaration.credential === "none" ? "none" : "required" },
        compatibility: { request: ["openai-chat"], response: ["openai-sse"], error: ["http-status"] },
    }, `declared provider ${id}`);
}

export function parseProviderDefinition(
    value: unknown,
    context: string,
): ProviderDefinition {
    if (!isRecord(value)) throw new Error(`${context}: expected an object`);
    const requiredStrings = ["id", "label", "short_label", "default_base_url"];
    for (const key of requiredStrings) {
        if (typeof value[key] !== "string" || value[key].length === 0) {
            throw new Error(`${context}: ${key} must be a non-empty string`);
        }
    }
    if (value.schema_version !== 1) throw new Error(`${context}: unsupported schema_version`);
    if (!isProviderAccess(value.access) || !isProviderCredential(value.credential)) {
        throw new Error(`${context}: invalid access or credential`);
    }
    if (!isProviderProtocol(value.protocol)) throw new Error(`${context}: invalid protocol`);
    if (typeof value.default_base_url !== "string" || !validProviderUrl(value.default_base_url)) {
        throw new Error(`${context}: unsafe default_base_url`);
    }
    if (value.fixed_endpoint !== undefined && typeof value.fixed_endpoint !== "boolean") {
        throw new Error(`${context}: fixed_endpoint must be boolean`);
    }
    if (value.protocol === "contributed" && typeof value.behavior_id !== "string") {
        throw new Error(`${context}: contributed protocol requires behavior_id`);
    }
    if (value.protocol !== "contributed" && value.behavior_id !== undefined) {
        throw new Error(`${context}: standard protocol cannot set behavior_id`);
    }
    const discovery = parseDiscovery(value.discovery, context);
    const compatibility = parseLayers(value.compatibility, context);
    if (value.credential === "oauth" && value.protocol !== "contributed") {
        throw new Error(`${context}: oauth requires contributed protocol`);
    }
    if (value.credential === "none" && value.access !== "local") {
        throw new Error(`${context}: credential none requires local access`);
    }
    return {
        schema_version: 1,
        ...(typeof value.order === "number" ? { order: value.order } : {}),
        id: value.id as string,
        label: value.label as string,
        short_label: value.short_label as string,
        access: value.access,
        credential: value.credential,
        ...(typeof value.hint === "string" ? { hint: value.hint } : {}),
        ...(typeof value.env_var === "string" ? { env_var: value.env_var } : {}),
        protocol: value.protocol,
        ...(typeof value.behavior_id === "string" ? { behavior_id: value.behavior_id } : {}),
        default_base_url: value.default_base_url as string,
        ...(value.fixed_endpoint === true ? { fixed_endpoint: true } : {}),
        discovery,
        compatibility,
    };
}

function parseDiscovery(value: unknown, context: string): ProviderDiscoveryDefinition {
    if (!isRecord(value) || !isDiscoveryMode(value.mode) || typeof value.path !== "string" || !value.path.startsWith("/")) {
        throw new Error(`${context}: invalid discovery definition`);
    }
    if (!isDiscoveryCredential(value.credential)) throw new Error(`${context}: invalid discovery credential`);
    return { mode: value.mode, path: value.path, credential: value.credential };
}

function parseLayers(value: unknown, context: string): ProviderCompatibilityLayers {
    if (!isRecord(value)) throw new Error(`${context}: compatibility must be an object`);
    const result: Record<string, readonly string[]> = {};
    for (const key of ["request", "response", "error", "effort", "catalog"]) {
        const layers = value[key];
        if (layers === undefined) continue;
        if (!Array.isArray(layers) || !layers.every((layer) => typeof layer === "string" && ALLOWED_LAYERS.has(layer))) {
            throw new Error(`${context}: unknown compatibility layer in ${key}`);
        }
        result[key] = layers;
    }
    return result as ProviderCompatibilityLayers;
}

function validProviderUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === "https:"
            || (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"));
    } catch {
        return false;
    }
}

function isRecord(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isProviderAccess(value: unknown): value is ProviderAccess {
    return value === "subscription" || value === "api_key" || value === "local";
}
function isProviderCredential(value: unknown): value is ProviderCredential {
    return value === "oauth" || value === "api_key" || value === "api_key_optional" || value === "none";
}
function isProviderProtocol(value: unknown): value is ProviderProtocol {
    return value === "openai-chat" || value === "anthropic-messages" || value === "contributed";
}
function isDiscoveryMode(value: unknown): value is ProviderDiscoveryMode {
    return value === "models" || value === "cache" || value === "none";
}
function isDiscoveryCredential(value: unknown): value is DiscoveryCredential {
    return value === "required" || value === "optional" || value === "none";
}
