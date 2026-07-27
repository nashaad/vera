import { randomUUID } from "node:crypto";
import {
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { CatalogModel } from "./catalog-shape.ts";

export interface StashStoreOptions {
    readonly path?: string;
}

export interface StashEntry {
    readonly provider: string;
    readonly model: string;
}

export interface ResolvedStashEntry extends StashEntry {
    readonly status: "resolved";
    readonly catalogModel: CatalogModel;
}

export interface UnavailableStashEntry extends StashEntry {
    readonly status: "unavailable";
}

export type StashResolution = ResolvedStashEntry | UnavailableStashEntry;

export function defaultStashPath(): string {
    return join(homedir(), ".vera", "config.json");
}

export function readStash(
    options: StashStoreOptions = {},
): readonly StashEntry[] {
    const config = readConfig(options.path ?? defaultStashPath());
    if (!Array.isArray(config.stash)) {
        return [];
    }

    return config.stash.flatMap((value) => {
        if (typeof value !== "string") {
            return [];
        }
        const entry = parseIdentifier(value);
        return entry === undefined ? [] : [entry];
    });
}

export function addToStash(
    entry: StashEntry,
    options: StashStoreOptions = {},
): readonly StashEntry[] {
    return updateStash(entry, true, options);
}

export function removeFromStash(
    entry: StashEntry,
    options: StashStoreOptions = {},
): readonly StashEntry[] {
    const identifier = formatIdentifier(entry);
    return writeUpdatedStash(options, (current) =>
        current.filter((value) => formatIdentifier(value) !== identifier)
    );
}

export function markStashEntryUsed(
    entry: StashEntry,
    options: StashStoreOptions = {},
): readonly StashEntry[] {
    return updateStash(entry, false, options);
}

export function resolveStash(
    entries: readonly StashEntry[],
    knownModels: ReadonlyMap<string, CatalogModel>,
): readonly StashResolution[] {
    return entries.map((entry) => {
        const catalogModel = knownModels.get(formatIdentifier(entry));
        if (catalogModel === undefined) {
            return {
                status: "unavailable",
                ...entry,
            };
        }
        return {
            status: "resolved",
            ...entry,
            catalogModel,
        };
    });
}

function updateStash(
    entry: StashEntry,
    addWhenMissing: boolean,
    options: StashStoreOptions,
): readonly StashEntry[] {
    const identifier = formatIdentifier(entry);
    return writeUpdatedStash(options, (current) => {
        const exists = current.some(
            (value) => formatIdentifier(value) === identifier,
        );
        if (!exists && !addWhenMissing) {
            return current;
        }
        return [
            entry,
            ...current.filter(
                (value) => formatIdentifier(value) !== identifier,
            ),
        ];
    });
}

function writeUpdatedStash(
    options: StashStoreOptions,
    update: (current: readonly StashEntry[]) => readonly StashEntry[],
): readonly StashEntry[] {
    const path = options.path ?? defaultStashPath();
    const config = readConfig(path);
    const current = readStash({ path });
    const updated = update(current);
    const directory = dirname(path);
    const temporaryPath = join(directory, `.config-${randomUUID()}.tmp`);

    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
        temporaryPath,
        `${JSON.stringify({
            ...config,
            stash: updated.map(formatIdentifier),
        }, null, 2)}\n`,
        { mode: 0o600 },
    );
    renameSync(temporaryPath, path);
    return updated;
}

function readConfig(path: string): Record<string, unknown> {
    try {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            return value as Record<string, unknown>;
        }
    } catch {
        return {};
    }
    return {};
}

function parseIdentifier(identifier: string): StashEntry | undefined {
    const separator = identifier.indexOf("/");
    if (separator <= 0 || separator === identifier.length - 1) {
        return undefined;
    }
    return {
        provider: identifier.slice(0, separator),
        model: identifier.slice(separator + 1),
    };
}

function formatIdentifier(entry: StashEntry): string {
    return `${entry.provider}/${entry.model}`;
}
