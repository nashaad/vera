import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { VeraConfig, VeraProviderProtocol } from "../src/config.ts";
import type { AuthStorage } from "../src/providers/auth-storage.ts";
import {
    configuredProviders,
    isProviderConnected,
    type ProviderDescriptor,
} from "../src/providers/registry.ts";
import {
    defaultCaptureDirectory,
    redactSecrets,
    REDACTED,
} from "../src/providers/failed-request-capture.ts";
import { veraRuntimeDirectory } from "../src/profile-paths.ts";

const DEFAULT_CAPTURES_PER_PROVIDER = 3;
const DEFAULT_PROBE_TIMEOUT_MS = 5000;

/**
 * Where the credential Vera would actually spend comes from.
 *
 * `isProviderConnected` answers yes for either source, which is the right
 * answer for the connect list and the wrong one here: a provider "connected"
 * through a stale exported variable and one connected through a stored key
 * fail differently and are fixed differently.
 */
export type ProviderCredentialSource = "stored" | "env" | "none";

/**
 * The outcomes a probe has to tell apart. Only `rejected` and `authenticated`
 * say anything about the credential, and only about the model-list endpoint:
 * `models_unlisted` and `unexpected` mean the host answered without testing it.
 */
export type ProviderReachability =
    | "unreachable"
    | "rejected"
    | "authenticated"
    | "models_unlisted"
    | "unexpected";

export interface ProviderProbeResult {
    readonly reachability: ProviderReachability;
    readonly url: string;
    readonly status?: number;
    readonly error?: string;
}

export interface ProviderEndpoint {
    readonly baseUrl: string;
    readonly protocol: VeraProviderProtocol;
}

export interface ProviderCaptureSummary {
    readonly timestamp: string;
    readonly model: string;
    readonly outcome: string;
    readonly error?: string;
    /** Root-relative, so the line can be pasted into a public issue. */
    readonly path: string;
}

export interface ProviderDiagnosis {
    readonly id: string;
    readonly custom: boolean;
    readonly connected: boolean;
    readonly credentialSource: ProviderCredentialSource;
    readonly envVar?: string;
    /** Set when the environment variable exists, whatever the stored key says. */
    readonly envVarPresent: boolean;
    readonly endpoint?: ProviderEndpoint;
    readonly probe?: ProviderProbeResult;
    readonly captures: readonly ProviderCaptureSummary[];
}

export interface ProviderDoctorReport {
    readonly providers: readonly ProviderDiagnosis[];
    readonly networkChecked: boolean;
}

export interface ProviderDoctorOptions {
    readonly authStorage?: Pick<AuthStorage, "getCredential">;
    readonly env?: Readonly<Record<string, string | undefined>>;
    /** Off by default: `vera doctor` stays offline unless asked. */
    readonly checkNetwork?: boolean;
    readonly fetch?: (
        input: string | URL | Request,
        init?: RequestInit,
    ) => Promise<Response>;
    readonly captureDirectory?: string;
    readonly maxCapturesPerProvider?: number;
    readonly probeTimeoutMs?: number;
    readonly homeDirectory?: string;
}

/**
 * Base URLs Vera's own adapters use. Kept here rather than imported because
 * each adapter takes its URL as a default argument, not as an exported value;
 * a drift between the two shows up as a probe against the wrong host, which
 * the reported URL makes visible.
 */
const BUILT_IN_ENDPOINTS: Readonly<Record<string, ProviderEndpoint>> = {
    openai: {
        baseUrl: "https://api.openai.com/v1",
        protocol: "openai-chat",
    },
    anthropic: {
        baseUrl: "https://api.anthropic.com/v1",
        protocol: "anthropic-messages",
    },
    cerebras: {
        baseUrl: "https://api.cerebras.ai/v1",
        protocol: "openai-chat",
    },
    deepseek: {
        baseUrl: "https://api.deepseek.com",
        protocol: "openai-chat",
    },
    openrouter: {
        baseUrl: "https://openrouter.ai/api/v1",
        protocol: "openai-chat",
    },
    omlx: {
        baseUrl: "http://127.0.0.1:8000/v1",
        protocol: "openai-chat",
    },
};

export async function diagnoseProviders(
    config: Pick<VeraConfig, "providers" | "provider_endpoints"> | undefined,
    options: ProviderDoctorOptions = {},
): Promise<ProviderDoctorReport> {
    const env = options.env ?? process.env;
    const captures = await readCaptureSummaries(options);
    const providers = await Promise.all(
        configuredProviders(config).map((descriptor) =>
            diagnoseProvider(descriptor, config, captures, options, env)
        ),
    );
    return {
        providers,
        networkChecked: options.checkNetwork === true,
    };
}

async function diagnoseProvider(
    descriptor: ProviderDescriptor,
    config: Pick<VeraConfig, "providers" | "provider_endpoints"> | undefined,
    captures: ReadonlyMap<string, readonly ProviderCaptureSummary[]>,
    options: ProviderDoctorOptions,
    env: Readonly<Record<string, string | undefined>>,
): Promise<ProviderDiagnosis> {
    const custom = config?.providers?.[descriptor.id];
    const endpoint = custom === undefined
        ? endpointFor(descriptor.id, env, config?.provider_endpoints?.[descriptor.id])
        : { baseUrl: custom.base_url, protocol: custom.protocol };
    const envVarPresent = descriptor.envVar !== undefined
        && Boolean(env[descriptor.envVar]);
    const credentialSource = resolveCredentialSource(
        descriptor,
        envVarPresent,
        options.authStorage,
    );
    const probe = options.checkNetwork === true && endpoint !== undefined
        ? await probeEndpoint(endpoint, descriptor, options, env)
        : undefined;
    return {
        id: descriptor.id,
        custom: custom !== undefined,
        connected: isProviderConnected(descriptor, {
            ...(options.authStorage === undefined
                ? {}
                : { authStorage: options.authStorage }),
            env,
        }),
        credentialSource,
        ...(descriptor.envVar === undefined
            ? {}
            : { envVar: descriptor.envVar }),
        envVarPresent,
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(probe === undefined ? {} : { probe }),
        captures: captures.get(descriptor.id) ?? [],
    };
}

function resolveCredentialSource(
    descriptor: ProviderDescriptor,
    envVarPresent: boolean,
    authStorage: Pick<AuthStorage, "getCredential"> | undefined,
): ProviderCredentialSource {
    if (descriptor.credential === "none") {
        return "none";
    }
    let stored;
    try {
        stored = authStorage?.getCredential(descriptor.id);
    } catch {
        stored = undefined;
    }
    // Stored wins because that is the order the adapters read them in; saying
    // "env" while the request spends the stored key sends the user to fix the
    // wrong thing.
    if (stored !== undefined) return "stored";
    return envVarPresent ? "env" : "none";
}

function endpointFor(
    id: string,
    env: Readonly<Record<string, string | undefined>>,
    moved?: string,
): ProviderEndpoint | undefined {
    if (id === "ollama") {
        const host = (moved ?? env.OLLAMA_HOST ?? "http://127.0.0.1:11434")
            .replace(/\/+$/, "")
            .replace(/\/v1$/, "");
        const withScheme = /^https?:\/\//.test(host) ? host : `http://${host}`;
        return {
            baseUrl: `${withScheme.replace(/\/+$/, "")}/v1`,
            protocol: "openai-chat",
        };
    }
    const shipped = BUILT_IN_ENDPOINTS[id];
    if (moved === undefined || shipped === undefined) {
        return shipped;
    }
    // The report probes where Vera would actually send the turn. A probe
    // against the shipped host would carry the credential somewhere the user
    // has said not to go, and report a reachable provider that is not the one
    // in use.
    return { baseUrl: moved, protocol: shipped.protocol };
}

/**
 * The cheapest request that separates "no host" from "host said no" from
 * "host said yes": a credentialed GET of the model list. It bills nothing and
 * needs no model name. It proves reachability and, at most, that this one
 * endpoint took the credential; a real turn carries options (max tokens,
 * reasoning effort, thinking, tools, images, streaming) it never exercises.
 */
/** The model-listing address for a base URL, preserving its query. */
function modelsProbeUrl(baseUrl: string): string {
    try {
        const url = new URL(baseUrl);
        url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
        return url.toString();
    } catch {
        return `${baseUrl.replace(/\/+$/, "")}/models`;
    }
}

async function probeEndpoint(
    endpoint: ProviderEndpoint,
    descriptor: ProviderDescriptor,
    options: ProviderDoctorOptions,
    env: Readonly<Record<string, string | undefined>>,
): Promise<ProviderProbeResult> {
    // Built by URL rather than concatenation: a base URL carrying a query
    // string would otherwise swallow the appended path and probe the wrong
    // address.
    const url = modelsProbeUrl(endpoint.baseUrl);
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const controller = new AbortController();
    const timeout = setTimeout(
        () => controller.abort(),
        options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    );
    try {
        const response = await fetchImpl(url, {
            method: "GET",
            headers: probeHeaders(endpoint, descriptor, options, env),
            signal: controller.signal,
        });
        return {
            reachability: classifyStatus(response.status),
            url,
            status: response.status,
        };
    } catch (error) {
        return {
            reachability: "unreachable",
            url,
            error: describeError(error),
        };
    } finally {
        clearTimeout(timeout);
    }
}

function classifyStatus(status: number): ProviderReachability {
    if (status === 401 || status === 403) return "rejected";
    if (status >= 200 && status < 300) return "authenticated";
    // A chat endpoint is under no obligation to serve `/models`, so these two
    // statuses are an absent listing rather than a fault.
    if (status === 404 || status === 405) return "models_unlisted";
    return "unexpected";
}

function probeHeaders(
    endpoint: ProviderEndpoint,
    descriptor: ProviderDescriptor,
    options: ProviderDoctorOptions,
    env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
    const secret = probeSecret(descriptor, options, env);
    if (secret === undefined) return {};
    return endpoint.protocol === "anthropic-messages"
        ? { "x-api-key": secret, "anthropic-version": "2023-06-01" }
        : { authorization: `Bearer ${secret}` };
}

function probeSecret(
    descriptor: ProviderDescriptor,
    options: ProviderDoctorOptions,
    env: Readonly<Record<string, string | undefined>>,
): string | undefined {
    let stored;
    try {
        stored = options.authStorage?.getCredential(descriptor.id);
    } catch {
        stored = undefined;
    }
    if (stored?.type === "api_key" && stored.key.length > 0) return stored.key;
    if (stored?.type === "oauth" && stored.token.length > 0) {
        return stored.token;
    }
    if (descriptor.envVar === undefined) return undefined;
    const fromEnv = env[descriptor.envVar];
    return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined;
}

async function readCaptureSummaries(
    options: ProviderDoctorOptions,
): Promise<ReadonlyMap<string, readonly ProviderCaptureSummary[]>> {
    const directory = options.captureDirectory ?? safeCaptureDirectory();
    const roots = capturePathRoots(options);
    const byProvider = new Map<string, ProviderCaptureSummary[]>();
    if (directory === undefined) return byProvider;
    let entries: string[];
    try {
        entries = await readdir(directory);
    } catch {
        return byProvider;
    }
    for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const summary = await readCapture(join(directory, entry), roots);
        if (summary === undefined) continue;
        const list = byProvider.get(summary.provider) ?? [];
        list.push(summary.capture);
        byProvider.set(summary.provider, list);
    }
    const limit = options.maxCapturesPerProvider
        ?? DEFAULT_CAPTURES_PER_PROVIDER;
    for (const [provider, list] of byProvider) {
        list.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
        byProvider.set(provider, list.slice(0, limit));
    }
    return byProvider;
}

interface CaptureRow {
    readonly provider: string;
    readonly capture: ProviderCaptureSummary;
}

/**
 * The writer redacts before it writes; this redacts again on the way out.
 * Nothing here widens what the file holds: only the five scalar fields the
 * summary names are read, and the request and response bodies are never
 * touched.
 */
async function readCapture(
    path: string,
    roots: readonly PathRoot[],
): Promise<CaptureRow | undefined> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
        return undefined;
    }
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    const provider = stringField(record.provider);
    if (provider === undefined) return undefined;
    const error = stringField(record.error);
    return {
        provider,
        capture: {
            timestamp: stringField(record.timestamp) ?? "unknown",
            model: stringField(record.model) ?? "unknown",
            outcome: stringField(record.outcome) ?? "unknown",
            ...(error === undefined ? {} : { error }),
            path: abbreviatePath(path, roots),
        },
    };
}

function stringField(value: unknown): string | undefined {
    if (typeof value !== "string" || value.length === 0) return undefined;
    const redacted = redactSecrets(value);
    return typeof redacted === "string" ? redacted : undefined;
}

export interface PathRoot {
    readonly root: string;
    readonly label: string;
}

/**
 * The first root that contains the path names it. Order is the caller's:
 * the home directory first, so a capture that sits under it keeps reading as
 * `~/...` even when a runtime override also covers it.
 */
export function abbreviatePath(
    path: string,
    roots: readonly PathRoot[],
): string {
    for (const { root, label } of roots) {
        if (root.length === 0) continue;
        if (path === root) return label;
        if (path.startsWith(`${root}/`)) {
            return `${label}${path.slice(root.length)}`;
        }
    }
    return path;
}

function capturePathRoots(options: ProviderDoctorOptions): PathRoot[] {
    const roots: PathRoot[] = [
        { root: options.homeDirectory ?? homedir(), label: "~" },
    ];
    try {
        roots.push({ root: veraRuntimeDirectory(), label: "<vera-runtime>" });
    } catch {
        // No runtime directory to name; the remaining roots still apply.
    }
    if (options.captureDirectory !== undefined) {
        roots.push({ root: options.captureDirectory, label: "<captures>" });
    }
    return roots;
}

function safeCaptureDirectory(): string | undefined {
    try {
        return defaultCaptureDirectory();
    } catch {
        return undefined;
    }
}

function describeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const redacted = redactSecrets(message);
    return typeof redacted === "string" ? redacted : "unknown error";
}

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s)\]}"'`,]+/gi;

/**
 * A URL with everything that can carry a credential removed: userinfo, query
 * values, and the fragment. `validProviderUrl` accepts any https URL, so a
 * configured base URL can hold a key in any of the three.
 */
export function sanitizeUrlForReport(raw: string): string {
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        return raw;
    }
    parsed.username = "";
    parsed.password = "";
    const keys = [...new Set(parsed.searchParams.keys())];
    const query = keys.length === 0
        ? ""
        : `?${keys.map((key) => `${key}=${REDACTED}`).join("&")}`;
    const fragment = parsed.hash.length === 0 ? "" : `#${REDACTED}`;
    // `URL` supplies a root path the input did not have; dropping it again
    // keeps a bare host reading the way it was configured.
    const path = parsed.pathname === "/" && !raw.split(/[?#]/)[0]?.endsWith("/")
        ? ""
        : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${path}${query}${fragment}`;
}

/** Every URL inside a free-text line, sanitized in place. */
function sanitizeUrlsInText(text: string): string {
    return text.replace(URL_IN_TEXT, (match) => sanitizeUrlForReport(match));
}

/**
 * The provider section of `vera doctor`, written to be pasted into a public
 * issue unedited: names of environment variables, never their values, no
 * absolute path that carries a directory the user owns, and no URL that still
 * carries its userinfo, query, or fragment. Sanitizing happens here rather
 * than at construction so a new caller cannot route around it.
 */
export function renderProviderDoctor(report: ProviderDoctorReport): string {
    const lines: string[] = ["Providers"];
    if (report.providers.length === 0) {
        lines.push("  No providers configured.");
        return `${lines.join("\n")}\n`;
    }
    for (const provider of report.providers) {
        lines.push(`  ${provider.id}${provider.custom ? " (custom)" : ""}`);
        lines.push(
            `    Credential: ${describeCredential(provider)}`,
        );
        if (provider.endpoint !== undefined) {
            lines.push(
                `    Endpoint: ${sanitizeUrlForReport(provider.endpoint.baseUrl)} (${provider.endpoint.protocol})`,
            );
        }
        if (provider.probe !== undefined) {
            lines.push(`    Network: ${describeProbe(provider.probe)}`);
        }
        for (const capture of provider.captures) {
            lines.push(
                `    Failed request ${capture.timestamp}  model ${capture.model}  ${capture.outcome}`,
            );
            if (capture.error !== undefined) {
                lines.push(`      ${sanitizeUrlsInText(capture.error)}`);
            }
            lines.push(`      ${capture.path}`);
        }
    }
    if (!report.networkChecked) {
        lines.push(
            "",
            "No provider was contacted. Run `vera doctor --check-providers` to test reachability and credentials.",
        );
    }
    return `${lines.join("\n")}\n`;
}

function describeCredential(provider: ProviderDiagnosis): string {
    if (provider.credentialSource === "stored") {
        const shadowed = provider.envVarPresent && provider.envVar !== undefined
            ? ` (${provider.envVar} is also set and unused)`
            : "";
        return `stored in Vera${shadowed}`;
    }
    if (provider.credentialSource === "env") {
        return `from ${provider.envVar ?? "the environment"}`;
    }
    if (provider.connected) {
        return "none needed";
    }
    return provider.envVar === undefined
        ? "not connected"
        : `not connected (no stored key, ${provider.envVar} unset)`;
}

/**
 * Every line says which endpoint answered and stops there. The probe is a GET
 * of the model list, so a success is evidence about that endpoint and that
 * credential, not about a turn the provider has yet to be asked to run.
 */
function describeProbe(probe: ProviderProbeResult): string {
    const target = sanitizeUrlForReport(probe.url);
    if (probe.reachability === "unreachable") {
        return `unreachable ${target} (${
            sanitizeUrlsInText(probe.error ?? "no response")
        })`;
    }
    if (probe.reachability === "rejected") {
        return `reached ${target}, which rejected the credential (HTTP ${probe.status})`;
    }
    if (probe.reachability === "authenticated") {
        return `reached ${target}, which accepted the credential (HTTP ${probe.status}); model listing only, a real request is not tested`;
    }
    if (probe.reachability === "models_unlisted") {
        return `reached ${target}, which does not list models (HTTP ${probe.status}); not a fault, and the credential was not tested`;
    }
    return `reached ${target}, unexpected HTTP ${probe.status}; the credential was not tested`;
}
