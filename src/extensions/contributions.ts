export const CONTRIBUTION_KINDS = ["watches", "sidecars", "skills"] as const;

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

export interface SidecarContribution {
    readonly id: string;
    readonly command: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly cwd?: string;
    readonly restart: boolean;
}

export interface ExtensionContributions {
    readonly watches: readonly WatchContribution[];
    readonly sidecars: readonly SidecarContribution[];
    // Skill directories relative to the extension directory.
    readonly skills: readonly string[];
}

export const EMPTY_EXTENSION_CONTRIBUTIONS: ExtensionContributions = Object
    .freeze({
        watches: Object.freeze([]) as readonly WatchContribution[],
        sidecars: Object.freeze([]) as readonly SidecarContribution[],
        skills: Object.freeze([]) as readonly string[],
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

export function canonicalSidecarId(
    extensionId: string,
    localId: string,
): string {
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
        sidecars: parseSidecarContributions(value.sidecars, extensionId),
        skills: parseSkillContributions(value.skills, extensionId),
    };
}

function parseSkillContributions(
    value: unknown,
    extensionId: string,
): readonly string[] {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new ExtensionContributionError(
            extensionId,
            "contributes.skills must be an array",
        );
    }
    const directories: string[] = [];
    for (const entry of value) {
        if (
            typeof entry !== "string"
            || entry.trim().length === 0
            || entry.startsWith("/")
            || entry.split(/[\\/]/).includes("..")
        ) {
            throw new ExtensionContributionError(
                extensionId,
                "a skills contribution must be a relative directory inside the extension",
            );
        }
        const directory = entry.trim();
        if (directories.includes(directory)) {
            throw new ExtensionContributionError(
                extensionId,
                `duplicate skills directory "${directory}"`,
            );
        }
        directories.push(directory);
    }
    return Object.freeze(directories);
}

function parseSidecarContributions(
    value: unknown,
    extensionId: string,
): readonly SidecarContribution[] {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new ExtensionContributionError(
            extensionId,
            "contributes.sidecars must be an array",
        );
    }

    const sidecars: SidecarContribution[] = [];
    const localIds = new Set<string>();
    for (const entry of value) {
        const sidecar = parseSidecarContribution(entry, extensionId);
        if (localIds.has(sidecar.id)) {
            throw new ExtensionContributionError(
                extensionId,
                `duplicate sidecar id "${sidecar.id}"`,
            );
        }
        localIds.add(sidecar.id);
        sidecars.push(sidecar);
    }
    return sidecars;
}

function parseSidecarContribution(
    value: unknown,
    extensionId: string,
): SidecarContribution {
    if (!isPlainObject(value)) {
        throw new ExtensionContributionError(
            extensionId,
            "a sidecar contribution must be an object",
        );
    }

    const id = value.id;
    if (typeof id !== "string" || !isWatchLocalId(id)) {
        throw new ExtensionContributionError(
            extensionId,
            `a sidecar id must match ${WATCH_LOCAL_ID_PATTERN.source}`,
        );
    }

    const command = value.command;
    if (
        !Array.isArray(command)
        || command.length === 0
        || command.some(
            (part) => typeof part !== "string" || part.trim().length === 0,
        )
    ) {
        throw new ExtensionContributionError(
            extensionId,
            `sidecar "${id}" command must be a non-empty array of non-empty strings`,
        );
    }

    const env = value.env === undefined
        ? EMPTY_SIDECAR_ENV
        : asStringRecord(value.env);
    if (env === undefined) {
        throw new ExtensionContributionError(
            extensionId,
            `sidecar "${id}" env must be an object of string values`,
        );
    }

    const cwd = value.cwd;
    if (
        cwd !== undefined
        && (typeof cwd !== "string" || cwd.trim().length === 0)
    ) {
        throw new ExtensionContributionError(
            extensionId,
            `sidecar "${id}" cwd must be a non-empty string`,
        );
    }

    const restart = value.restart ?? true;
    if (typeof restart !== "boolean") {
        throw new ExtensionContributionError(
            extensionId,
            `sidecar "${id}" restart must be a boolean`,
        );
    }

    return Object.freeze({
        id,
        command: Object.freeze([...command]) as readonly string[],
        env,
        ...(cwd === undefined ? {} : { cwd: cwd.trim() }),
        restart,
    });
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

export const WATCH_CONFIG_OVERRIDE_KEY = "watches";

export function applyWatchConfigOverrides(
    contributions: ExtensionContributions,
    extensionConfig: unknown,
    extensionId: string,
): ExtensionContributions {
    if (!isPlainObject(extensionConfig)) {
        return contributions;
    }
    const overrides = extensionConfig[WATCH_CONFIG_OVERRIDE_KEY];
    if (overrides === undefined) {
        return contributions;
    }
    if (!isPlainObject(overrides)) {
        throw new ExtensionContributionError(
            extensionId,
            `config.${WATCH_CONFIG_OVERRIDE_KEY} must be an object keyed by watch id`,
        );
    }

    const declared = new Set(contributions.watches.map((watch) => watch.id));
    for (const localId of Object.keys(overrides)) {
        if (!declared.has(localId)) {
            throw new ExtensionContributionError(
                extensionId,
                `config.${WATCH_CONFIG_OVERRIDE_KEY} names watch "${localId}", which the manifest does not declare`,
            );
        }
    }

    return Object.freeze({
        sidecars: contributions.sidecars,
        skills: contributions.skills,
        watches: Object.freeze(
            contributions.watches.map((watch) => {
                const override = overrides[watch.id];
                if (override === undefined) {
                    return watch;
                }
                const parsed = asJsonObject(override);
                if (parsed === undefined) {
                    throw new ExtensionContributionError(
                        extensionId,
                        `config.${WATCH_CONFIG_OVERRIDE_KEY}."${watch.id}" must be an object of inert JSON values`,
                    );
                }
                return Object.freeze({
                    ...watch,
                    config: Object.freeze({ ...watch.config, ...parsed }),
                });
            }),
        ) as readonly WatchContribution[],
    });
}

export function stripWatchConfigOverrides(extensionConfig: unknown): unknown {
    if (
        !isPlainObject(extensionConfig)
        || extensionConfig[WATCH_CONFIG_OVERRIDE_KEY] === undefined
    ) {
        return extensionConfig;
    }
    const { [WATCH_CONFIG_OVERRIDE_KEY]: _removed, ...rest } = extensionConfig;
    return rest;
}

/** Shared by every watch that declares no config, so it must not be mutable. */
const EMPTY_WATCH_CONFIG: JsonObject = Object.freeze({});

/** Shared by every sidecar that declares no env, so it must not be mutable. */
const EMPTY_SIDECAR_ENV: Readonly<Record<string, string>> = Object.freeze({});

function asStringRecord(
    value: unknown,
): Readonly<Record<string, string>> | undefined {
    if (!isPlainObject(value)) {
        return undefined;
    }
    const result: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (key === "__proto__" || typeof entry !== "string") {
            return undefined;
        }
        result[key] = entry;
    }
    return Object.freeze(result);
}

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
