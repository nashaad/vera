import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { VeraConfig, VeraProviderProtocol } from "../src/config.ts";
import type { AuthStorage } from "../src/providers/auth-storage.ts";
import {
    configuredProviders,
    findProvider,
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

export type ProviderCredentialSource = "stored" | "env" | "none";

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
    readonly path: string;
}

export interface ProviderDiagnosis {
    readonly id: string;
    readonly custom: boolean;
    readonly connected: boolean;
    readonly credentialSource: ProviderCredentialSource;
    readonly envVar?: string;
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

export async function diagnoseProviders(
    config: Pick<VeraConfig, "providers" | "provider_endpoints"> | undefined,
    options: ProviderDoctorOptions = {},
): Promise<ProviderDoctorReport> {
    const env = options.env ?? process.env;
    const captures = await readCaptureSummaries(options);
    const safeConfig = doctorConfig(config);
    const providers = await Promise.all(
        configuredProviders(safeConfig).map((descriptor) =>
            diagnoseProvider(descriptor, safeConfig, captures, options, env)
        ),
    );
    return {
        providers,
        networkChecked: options.checkNetwork === true,
    };
}

function doctorConfig(
    config: Pick<VeraConfig, "providers" | "provider_endpoints"> | undefined,
): Pick<VeraConfig, "providers" | "provider_endpoints"> | undefined {
    if (config === undefined || config.provider_endpoints === undefined) {
        return config;
    }
    const provider_endpoints = Object.fromEntries(
        Object.entries(config.provider_endpoints).filter(([id]) =>
            findProvider(id)?.fixedEndpoint !== true
        ),
    );
    return { ...config, provider_endpoints };
}

async function diagnoseProvider(
    descriptor: ProviderDescriptor,
    config: Pick<VeraConfig, "providers" | "provider_endpoints"> | undefined,
    captures: ReadonlyMap<string, readonly ProviderCaptureSummary[]>,
    options: ProviderDoctorOptions,
    env: Readonly<Record<string, string | undefined>>,
): Promise<ProviderDiagnosis> {
    const custom = config?.providers?.[descriptor.id];
    const endpoint = endpointFor(
        descriptor,
        env,
        custom?.base_url ?? config?.provider_endpoints?.[descriptor.id],
    );
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
    if (stored !== undefined) return "stored";
    return envVarPresent ? "env" : "none";
}

function endpointFor(
    descriptor: ProviderDescriptor,
    env: Readonly<Record<string, string | undefined>>,
    moved?: string,
): ProviderEndpoint | undefined {
    if (descriptor.protocol === "contributed") return undefined;
    if (descriptor.envVar === "OLLAMA_HOST") {
        const host = (moved ?? env.OLLAMA_HOST ?? "http://127.0.0.1:11434")
            .replace(/\/+$/, "")
            .replace(/\/v1$/, "");
        const withScheme = /^https?:\/\//.test(host) ? host : `http://${host}`;
        return {
            baseUrl: `${withScheme.replace(/\/+$/, "")}/v1`,
            protocol: doctorProtocol(descriptor),
        };
    }
    if (descriptor.baseUrl === undefined) return undefined;
    const shipped = {
        baseUrl: descriptor.baseUrl,
        protocol: doctorProtocol(descriptor),
    } satisfies ProviderEndpoint;
    if (moved === undefined) return shipped;
    return { baseUrl: moved, protocol: shipped.protocol };
}

function doctorProtocol(descriptor: ProviderDescriptor): VeraProviderProtocol {
    return descriptor.protocol === "anthropic-messages"
        ? "anthropic-messages"
        : "openai-chat";
}

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
    // Built by URL rather than concatenation: a base URL carrying a query string would otherwise swallow the appended path and probe the wrong address.
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
    if (descriptor.credential === "none") return undefined;
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
    const path = parsed.pathname === "/" && !raw.split(/[?#]/)[0]?.endsWith("/")
        ? ""
        : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${path}${query}${fragment}`;
}

function sanitizeUrlsInText(text: string): string {
    return text.replace(URL_IN_TEXT, (match) => sanitizeUrlForReport(match));
}

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
