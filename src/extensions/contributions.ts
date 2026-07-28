export const CONTRIBUTION_KINDS = ["watches"] as const;

export type ContributionKind = typeof CONTRIBUTION_KINDS[number];

export const WATCH_FLOOD_POLICIES = ["shed", "quarantine"] as const;

export type WatchFloodPolicy = typeof WATCH_FLOOD_POLICIES[number];

export type JsonValue =
    | null
    | boolean
    | number
    | string
    | readonly JsonValue[]
    | JsonObject;

export interface JsonObject {
    readonly [key: string]: JsonValue;
}

export interface WatchContribution {
    readonly id: string;
    readonly source_family: string;
    readonly config: JsonObject;
    readonly address?: string;
    readonly flood: WatchFloodPolicy;
}

export interface ExtensionContributions {
    readonly watches: readonly WatchContribution[];
}

export const EMPTY_EXTENSION_CONTRIBUTIONS: ExtensionContributions = Object
    .freeze({
        watches: Object.freeze([]) as readonly WatchContribution[],
    });

export class ExtensionContributionError extends Error {
    readonly extensionId: string;

    constructor(extensionId: string, detail: string) {
        super(`Extension ${extensionId} declares an invalid contribution: ${detail}`);
        this.name = "ExtensionContributionError";
        this.extensionId = extensionId;
    }
}

export function canonicalWatchId(extensionId: string, localId: string): string {
    return `${extensionId}/${localId}`;
}

export function parseExtensionContributions(
    value: unknown,
    extensionId: string,
): ExtensionContributions {
    if (value === undefined) {
        return EMPTY_EXTENSION_CONTRIBUTIONS;
    }
    if (!isPlainObject(value)) {
        throw new ExtensionContributionError(
            extensionId,
            "contributes must be an object keyed by contribution kind",
        );
    }

    for (const kind of Object.keys(value)) {
        if (!(CONTRIBUTION_KINDS as readonly string[]).includes(kind)) {
            throw new ExtensionContributionError(
                extensionId,
                `unknown contribution kind "${kind}"`,
            );
        }
    }

    return {
        watches: parseWatchContributions(value.watches, extensionId),
    };
}

function parseWatchContributions(
    value: unknown,
    extensionId: string,
): readonly WatchContribution[] {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new ExtensionContributionError(
            extensionId,
            "contributes.watches must be an array",
        );
    }

    const watches: WatchContribution[] = [];
    const localIds = new Set<string>();
    for (const entry of value) {
        const watch = parseWatchContribution(entry, extensionId);
        if (localIds.has(watch.id)) {
            throw new ExtensionContributionError(
                extensionId,
                `duplicate watch id "${watch.id}"`,
            );
        }
        localIds.add(watch.id);
        watches.push(watch);
    }
    return watches;
}

function parseWatchContribution(
    value: unknown,
    extensionId: string,
): WatchContribution {
    if (!isPlainObject(value)) {
        throw new ExtensionContributionError(
            extensionId,
            "a watch contribution must be an object",
        );
    }

    const id = value.id;
    if (typeof id !== "string" || !isWatchLocalId(id)) {
        throw new ExtensionContributionError(
            extensionId,
            `a watch id must match ${WATCH_LOCAL_ID_PATTERN.source}`,
        );
    }

    const sourceFamily = value.source_family;
    if (typeof sourceFamily !== "string" || !isSourceFamily(sourceFamily)) {
        throw new ExtensionContributionError(
            extensionId,
            `watch "${id}" must declare a source_family matching ${SOURCE_FAMILY_PATTERN.source}`,
        );
    }

    const config = value.config === undefined
        ? EMPTY_WATCH_CONFIG
        : asJsonObject(value.config);
    if (config === undefined) {
        throw new ExtensionContributionError(
            extensionId,
            `watch "${id}" config must be an object of inert JSON values`,
        );
    }

    const address = value.address;
    if (
        address !== undefined
        && (typeof address !== "string" || address.trim().length === 0)
    ) {
        throw new ExtensionContributionError(
            extensionId,
            `watch "${id}" address must be a non-empty string`,
        );
    }

    const flood = value.flood ?? "shed";
    if (
        typeof flood !== "string"
        || !(WATCH_FLOOD_POLICIES as readonly string[]).includes(flood)
    ) {
        throw new ExtensionContributionError(
            extensionId,
            `watch "${id}" flood must be one of ${WATCH_FLOOD_POLICIES.join(", ")}`,
        );
    }

    return Object.freeze({
        id,
        source_family: sourceFamily,
        config,
        ...(address === undefined ? {} : { address: address.trim() }),
        flood: flood as WatchFloodPolicy,
    });
}

/** Shared by every watch that declares no config, so it must not be mutable. */
const EMPTY_WATCH_CONFIG: JsonObject = Object.freeze({});

const WATCH_LOCAL_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SOURCE_FAMILY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isWatchLocalId(value: string): boolean {
    return WATCH_LOCAL_ID_PATTERN.test(value);
}

function isSourceFamily(value: string): boolean {
    return SOURCE_FAMILY_PATTERN.test(value);
}

function asJsonObject(value: unknown): JsonObject | undefined {
    if (!isPlainObject(value)) {
        return undefined;
    }
    const result: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (key === "__proto__") {
            return undefined;
        }
        const json = asJsonValue(entry);
        if (json === undefined) {
            return undefined;
        }
        result[key] = json;
    }
    return Object.freeze(result);
}

function asJsonValue(value: unknown): JsonValue | undefined {
    if (value === null || typeof value === "boolean" || typeof value === "string") {
        return value;
    }
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined;
    }
    if (Array.isArray(value)) {
        const items: JsonValue[] = [];
        for (const entry of value) {
            const json = asJsonValue(entry);
            if (json === undefined) {
                return undefined;
            }
            items.push(json);
        }
        return Object.freeze(items);
    }
    return asJsonObject(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object"
        && value !== null
        && !Array.isArray(value);
}
