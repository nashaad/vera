import { isIP } from "node:net";
import { configProblem, expectedValue, isPlainObject, keyValue } from "./diagnostic.ts";
import type { SandboxNetworkMode } from "../sdk/sandbox.ts";

export interface SandboxConfig {
    readonly enabled: boolean;
    readonly network: SandboxNetworkMode;
    readonly allowed_domains: readonly string[];
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = Object.freeze({
    enabled: false,
    network: "open",
    allowed_domains: [],
});

const SANDBOX_KEYS = new Set([
    "enabled",
    "network",
    "allowed_domains",
]);

export function parseSandboxConfig(value: unknown): SandboxConfig | undefined {
    if (value === undefined) return DEFAULT_SANDBOX_CONFIG;
    if (!isPlainObject(value)) {
        return configProblem("sandbox", expectedValue("an object", value));
    }
    for (const key of Object.keys(value)) {
        if (!SANDBOX_KEYS.has(key)) {
            return configProblem(`sandbox.${key}`, "unknown key");
        }
    }
    const enabled = value.enabled ?? false;
    if (typeof enabled !== "boolean") {
        return configProblem("sandbox.enabled", expectedValue("true or false", enabled));
    }
    const network = value.network ?? "open";
    if (network !== "open" && network !== "allowlist") {
        return configProblem(
            "sandbox.network",
            expectedValue("open or allowlist", network),
        );
    }
    const allowedDomains = parseDomainList(value.allowed_domains);
    if (allowedDomains === undefined) return undefined;
    return { enabled, network, allowed_domains: allowedDomains };
}

function parseDomainList(value: unknown): readonly string[] | undefined {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        return configProblem(
            "sandbox.allowed_domains",
            expectedValue("an array of hosts", value),
        );
    }
    const entries: string[] = [];
    for (const entry of value) {
        if (typeof entry !== "string") {
            return configProblem(
                "sandbox.allowed_domains",
                expectedValue("an array of hosts", value),
            );
        }
        if (entry.trim() !== entry || !isValidDomainEntry(entry)) {
            return configProblem(
                "sandbox.allowed_domains",
                keyValue("host", DOMAIN_RULE, entry),
            );
        }
        entries.push(entry);
    }
    return entries;
}

const DOMAIN_RULE =
    "a hostname, optionally with :port or a *. prefix; * alone is not allowed";

// Wildcards are valid only as a whole leftmost label; `*` alone would allow
// every host, which is what mode open is for.
function isValidDomainEntry(entry: string): boolean {
    if (entry === "" || entry === "*" || /[\s/\\]/.test(entry)) return false;
    if (entry.includes("://")) return false;
    const { host, port } = splitPort(entry);
    if (port !== undefined) {
        if (!/^\d{1,5}$/.test(port)) return false;
        const number = Number(port);
        if (number < 1 || number > 65535) return false;
    }
    if (host.startsWith("[") && host.endsWith("]")) {
        return isIP(host.slice(1, -1)) === 6;
    }
    if (isIP(host) !== 0) return true;
    if (host === "localhost") return true;
    const wildcard = host.startsWith("*.");
    const labels = wildcard ? host.slice(2).split(".") : host.split(".");
    if (wildcard && labels.length < 2) return false;
    return labels.every(isHostLabel);
}

function isHostLabel(label: string): boolean {
    if (label === "" || label.length > 63) return false;
    return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label);
}

function splitPort(entry: string): { readonly host: string; readonly port?: string } {
    const colon = entry.lastIndexOf(":");
    if (colon === -1) return { host: entry };
    return { host: entry.slice(0, colon), port: entry.slice(colon + 1) };
}
