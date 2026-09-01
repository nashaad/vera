import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const VERA_HOME_ENV = "VERA_HOME";
export const VERA_RUNTIME_DIR_ENV = "VERA_RUNTIME_DIR";

export const DEFAULT_PROFILE_NAME = "default";

/** Everything Vera owns on this machine. `VERA_HOME` relocates the tree. */
export function veraHomeDirectory(home?: string): string {
    if (home !== undefined) return join(home, ".vera");
    const override = process.env[VERA_HOME_ENV]?.trim();
    if (override !== undefined && override.length > 0) return override;
    return join(homedir(), ".vera");
}

/**
 * State that is one picture per machine: credentials and the live process
 * board. Sits beside config and runtime, not under a profile name.
 */
export function veraMachineDirectory(home?: string): string {
    return join(veraHomeDirectory(home), "machine");
}

/**
 * Config, extensions, skills, and memory. One home: this is the home
 * directory itself.
 */
export function veraProfileDirectory(_env = process.env, home?: string): string {
    return veraHomeDirectory(home);
}

/**
 * Sessions, socket, lock, logs. `VERA_RUNTIME_DIR` is the explicit instance
 * root for tests and worktree trials, not a second daily home.
 */
export function veraRuntimeDirectory(env = process.env, home?: string): string {
    const override = env[VERA_RUNTIME_DIR_ENV]?.trim();
    if (override !== undefined && override.length > 0) return override;
    return join(veraHomeDirectory(home), "runtime");
}

export class VeraProfileError extends Error {}

/** The old profiles/ tree. A home that still has it has not been migrated. */
export function legacyProfileLayoutEntries(home?: string): readonly string[] {
    const root = veraHomeDirectory(home);
    return existsSync(join(root, "profiles")) ? ["profiles"] : [];
}

/**
 * Refuses an unmigrated profiles/ home rather than reading the new paths and
 * finding nothing.
 */
export function assertProfileLayout(home?: string): void {
    const root = veraHomeDirectory(home);
    if (existsSync(join(root, "user"))) {
        throw new VeraProfileError(
            `${join(root, "user")} is the old name for the machine tier.\n`
            + `Rename it, then start Vera again:\n`
            + `  mv ${join(root, "user")} ${veraMachineDirectory(home)}`,
        );
    }
    const found = legacyProfileLayoutEntries(home);
    if (found.length === 0) return;
    throw new VeraProfileError(
        `${root} still uses the profiles/ layout.\n`
        + `Run vera migrate-home, then start Vera again.`,
    );
}

/** Names the single-home layout owns at the root. */
const KNOWN_ENTRIES = [
    "machine",
    "runtime",
    "config.json",
    "pool.json",
    "preferences.json",
    "extensions",
    "skills",
    "memory",
    "agents",
];

export function unrecognisedHomeEntries(home?: string): readonly string[] {
    const root = veraHomeDirectory(home);
    if (!existsSync(root)) return [];
    return readdirSync(root)
        .filter((entry) => !entry.startsWith("."))
        .filter((entry) => !KNOWN_ENTRIES.includes(entry))
        .sort();
}

/** @deprecated Use legacyProfileLayoutEntries. Kept while callers migrate. */
export function legacyLayoutEntries(home?: string): readonly string[] {
    return legacyProfileLayoutEntries(home);
}
