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

export interface PinStoreOptions {
    readonly path?: string;
}

export interface PinEntry {
    readonly provider: string;
    readonly model: string;
}

export interface ResolvedPinEntry extends PinEntry {
    readonly status: "resolved";
    readonly catalogModel: CatalogModel;
}

export interface UnavailablePinEntry extends PinEntry {
    readonly status: "unavailable";
}

export type PinResolution = ResolvedPinEntry | UnavailablePinEntry;

export function defaultPinsPath(): string {
    return join(homedir(), ".vera", "config.json");
}

export function readPins(
    options: PinStoreOptions = {},
): readonly PinEntry[] {
    const config = readConfig(options.path ?? defaultPinsPath());
    if (!Array.isArray(config.pinned)) {
        return [];
    }

    return config.pinned.flatMap((value) => {
        if (typeof value !== "string") {
            return [];
        }
        const entry = parseIdentifier(value);
        return entry === undefined ? [] : [entry];
    });
}

export function addPin(
    entry: PinEntry,
    options: PinStoreOptions = {},
): readonly PinEntry[] {
    return addPinToFront(entry, options);
}

export function removePin(
    entry: PinEntry,
    options: PinStoreOptions = {},
): readonly PinEntry[] {
    const identifier = formatIdentifier(entry);
    return writeUpdatedPins(options, (current) =>
        current.filter((value) => formatIdentifier(value) !== identifier)
    );
}

export function resolvePins(
    entries: readonly PinEntry[],
    knownModels: ReadonlyMap<string, CatalogModel>,
): readonly PinResolution[] {
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

/**
 * Pin order is when each model was pinned, newest first, and using a model does
 * not move it. A list that reorders itself under the user is a list they cannot
 * aim at: the point of an explicit pin over a recents list is that the row stays
 * where they left it.
 */
function addPinToFront(
    entry: PinEntry,
    options: PinStoreOptions,
): readonly PinEntry[] {
    const identifier = formatIdentifier(entry);
    return writeUpdatedPins(options, (current) => [
        entry,
        ...current.filter((value) => formatIdentifier(value) !== identifier),
    ]);
}

function writeUpdatedPins(
    options: PinStoreOptions,
    update: (current: readonly PinEntry[]) => readonly PinEntry[],
): readonly PinEntry[] {
    const path = options.path ?? defaultPinsPath();
    const config = readConfig(path);
    const current = readPins({ path });
    const updated = update(current);
    const directory = dirname(path);
    const temporaryPath = join(directory, `.config-${randomUUID()}.tmp`);

    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
        temporaryPath,
        `${JSON.stringify({
            ...config,
            pinned: updated.map(formatIdentifier),
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

function parseIdentifier(identifier: string): PinEntry | undefined {
    const separator = identifier.indexOf("/");
    if (separator <= 0 || separator === identifier.length - 1) {
        return undefined;
    }
    return {
        provider: identifier.slice(0, separator),
        model: identifier.slice(separator + 1),
    };
}

function formatIdentifier(entry: PinEntry): string {
    return `${entry.provider}/${entry.model}`;
}
