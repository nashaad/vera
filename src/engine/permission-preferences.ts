
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
    isPermissionPredicate,
    permissionPredicateMatches,
} from "./permission-grants.ts";
import type {
    PermissionActionDecision,
    PermissionPredicate,
} from "./permissions.ts";
import { veraProfileDirectory } from "../profile-paths.ts";

export interface PermissionPreference {
    readonly id: string;
    readonly when: PermissionPredicate;
    readonly createdAt: string;
}

export function defaultPermissionPreferencesPath(): string {
    return join(veraProfileDirectory(), "preferences.json");
}

export function isPermissionPreference(
    value: unknown,
): value is PermissionPreference {
    return isRecord(value)
        && typeof value.id === "string"
        && value.id.length > 0
        && typeof value.createdAt === "string"
        && value.createdAt.length > 0
        && isPermissionPredicate(value.when);
}

export async function loadPermissionPreferences(
    path: string = defaultPermissionPreferencesPath(),
): Promise<readonly PermissionPreference[]> {
    let raw: string;
    try {
        raw = await readFile(path, "utf8");
    } catch (error) {
        if (isMissingFileError(error)) {
            return [];
        }
        throw error;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    return Array.isArray(parsed) ? parsed.filter(isPermissionPreference) : [];
}

export async function addPermissionPreference(
    when: PermissionPredicate,
    path: string = defaultPermissionPreferencesPath(),
): Promise<PermissionPreference> {
    if (!isPermissionPredicate(when)) {
        throw new Error(
            "Cannot add a permission preference with an invalid predicate",
        );
    }
    const preferences = await loadPermissionPreferences(path);
    const preference: PermissionPreference = {
        id: randomUUID(),
        when,
        createdAt: new Date().toISOString(),
    };
    await savePermissionPreferences([...preferences, preference], path);
    return preference;
}

export async function listPermissionPreferences(
    path: string = defaultPermissionPreferencesPath(),
): Promise<readonly PermissionPreference[]> {
    return loadPermissionPreferences(path);
}

export async function removePermissionPreference(
    id: string,
    path: string = defaultPermissionPreferencesPath(),
): Promise<boolean> {
    const preferences = await loadPermissionPreferences(path);
    const remaining = preferences.filter((preference) => preference.id !== id);
    if (remaining.length === preferences.length) {
        return false;
    }
    await savePermissionPreferences(remaining, path);
    return true;
}

/** A loaded preferences file, held in memory so the synchronous classifier can read it. */
export class PermissionPreferenceStore {
    private preferences: readonly PermissionPreference[];
    private pending: Promise<unknown> = Promise.resolve();

    private constructor(
        private readonly path: string,
        preferences: readonly PermissionPreference[],
    ) {
        this.preferences = preferences;
    }

    static async open(
        path: string = defaultPermissionPreferencesPath(),
    ): Promise<PermissionPreferenceStore> {
        return new PermissionPreferenceStore(
            path,
            await loadPermissionPreferences(path),
        );
    }

    list(): readonly PermissionPreference[] {
        return this.preferences;
    }

    async add(when: PermissionPredicate): Promise<PermissionPreference> {
        return this.serialize(async () => {
            const preference = await addPermissionPreference(when, this.path);
            this.preferences = [...this.preferences, preference];
            return preference;
        });
    }

    async remove(id: string): Promise<boolean> {
        return this.serialize(async () => {
            const removed = await removePermissionPreference(id, this.path);
            if (removed) {
                this.preferences = this.preferences.filter(
                    (preference) => preference.id !== id,
                );
            }
            return removed;
        });
    }

    private serialize<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.pending.then(operation, operation);
        this.pending = result.catch(() => undefined);
        return result;
    }
}

async function savePermissionPreferences(
    preferences: readonly PermissionPreference[],
    path: string,
): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
}

export function applyPermissionPreference(
    decision: PermissionActionDecision,
    preferences: readonly PermissionPreference[],
): PermissionActionDecision {
    if (decision.outcome !== "ask" && decision.outcome !== "review") {
        return decision;
    }
    const preference = preferences.find((candidate) =>
        permissionPredicateMatches(candidate.when, decision.action)
    );
    return preference === undefined
        ? decision
        : { ...decision, outcome: "allow", preference: preference.id };
}

function isMissingFileError(value: unknown): boolean {
    return value instanceof Error
        && "code" in value
        && (value as { code?: unknown }).code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
