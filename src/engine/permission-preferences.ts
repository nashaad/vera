/**
 * Preferences are a third, durable persistence tier for permission
 * decisions, distinct from in-memory session grants
 * (`permission-grants.ts`). A preference shares the grant's predicate shape
 * and the same safety rail — it can only lower a matching `ask`/`review` to
 * `allow`, never override a `deny` or the accident guard — but it survives
 * across sessions because it is stored on disk at `~/.vera/preferences.json`
 * rather than in a session's event log.
 *
 * Preferences are additive on top of whichever policy is active; they are
 * not a policy/profile of their own, so a user never has to author a
 * profile just to persist one allow decision.
 */

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

/**
 * Reads every preference from disk. A missing file reads as no preferences;
 * a present-but-unparseable file also reads as no preferences rather than
 * failing startup, since a preferences file is an optional convenience, not
 * something Vera depends on to run. Malformed individual entries are
 * dropped rather than rejecting the whole file.
 */
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

/** Returns `true` if a preference with that ID was removed. */
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

/**
 * A loaded preferences file, held in memory so the synchronous classifier can
 * read it.
 *
 * The free functions above are each a self-contained read-modify-write, which
 * is fine for a one-shot CLI call but not for the host: `decideToolPermission`
 * is synchronous and cannot await a file read per tool call. So the host opens
 * the store once at startup, reads through `list()`, and mutates through
 * `add`/`remove`, which keep the cache and the file in step.
 *
 * Writes are serialized through `pending` because two concurrent `add` calls
 * would otherwise both read the pre-write file and the second would clobber
 * the first.
 */
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

    /** Returns `true` if a preference with that ID was removed. */
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
        // Swallowed here only to keep one failed write from poisoning the
        // chain; the caller still sees the rejection through `result`.
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

/**
 * Same safety rail as `applyPermissionGrant`: only ever lowers `ask` or
 * `review` to `allow`. A `deny` is never touched here — a profile denial is
 * left alone, and the accident guard has already returned before any of
 * this runs.
 */
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
