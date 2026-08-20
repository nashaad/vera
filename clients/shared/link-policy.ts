import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type LinkPathShape = "any" | "empty" | "non-empty";

interface LinkRule {
    readonly id: string;
    readonly scheme: string;
    readonly hosts: readonly string[];
    readonly path: LinkPathShape;
    readonly required_query?: readonly string[];
    readonly allowed_query?: readonly string[];
    readonly allow_extra_query?: boolean;
}

interface LinkRegistry {
    readonly schema_version: 1;
    readonly links: readonly LinkRule[];
}

const LINK_REGISTRY_PATH = fileURLToPath(
    new URL("../../config/link-schemes.json", import.meta.url),
);

const LINK_RULES = loadLinkRules();

export function isSupportedLink(url: string): boolean {
    try {
        const parsed = new URL(url);
        return LINK_RULES.some((rule) => matchesLinkRule(parsed, rule));
    } catch {
        return false;
    }
}

function loadLinkRules(): readonly LinkRule[] {
    const value: unknown = JSON.parse(
        readFileSync(LINK_REGISTRY_PATH, "utf8"),
    );
    if (!isLinkRegistry(value)) {
        throw new Error(`Invalid link registry at ${LINK_REGISTRY_PATH}`);
    }
    return value.links;
}

function matchesLinkRule(url: URL, rule: LinkRule): boolean {
    const scheme = url.protocol.slice(0, -1).toLowerCase();
    if (scheme !== rule.scheme.toLowerCase()) return false;

    const host = url.hostname.toLowerCase();
    if (!rule.hosts.some((candidate) => (
        candidate === "*" || candidate.toLowerCase() === host
    ))) {
        return false;
    }

    if (rule.path === "empty" && url.pathname.length > 0) return false;
    if (rule.path === "non-empty" && url.pathname.length === 0) return false;

    const queryKeys = new Set(url.searchParams.keys());
    for (const key of rule.required_query ?? []) {
        if (!queryKeys.has(key)) return false;
    }
    if (rule.allow_extra_query !== true) {
        const allowed = new Set([
            ...(rule.required_query ?? []),
            ...(rule.allowed_query ?? []),
        ]);
        for (const key of queryKeys) {
            if (!allowed.has(key)) return false;
        }
    }

    return true;
}

function isLinkRegistry(value: unknown): value is LinkRegistry {
    if (!isObject(value)) return false;
    if (value.schema_version !== 1 || !Array.isArray(value.links)) {
        return false;
    }
    return value.links.every(isLinkRule);
}

function isLinkRule(value: unknown): value is LinkRule {
    if (!isObject(value)) return false;
    if (
        typeof value.id !== "string"
        || typeof value.scheme !== "string"
        || !Array.isArray(value.hosts)
        || !value.hosts.every((host) => typeof host === "string")
        || !isLinkPathShape(value.path)
    ) {
        return false;
    }
    if (
        value.required_query !== undefined
        && (!Array.isArray(value.required_query)
            || !value.required_query.every((key) => typeof key === "string"))
    ) {
        return false;
    }
    if (
        value.allowed_query !== undefined
        && (!Array.isArray(value.allowed_query)
            || !value.allowed_query.every((key) => typeof key === "string"))
    ) {
        return false;
    }
    return value.allow_extra_query === undefined
        || typeof value.allow_extra_query === "boolean";
}

function isLinkPathShape(value: unknown): value is LinkPathShape {
    return value === "any" || value === "empty" || value === "non-empty";
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
