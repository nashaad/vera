import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const VERA_HOME_ENV = "VERA_HOME";
export const VERA_PROFILE_ENV = "VERA_PROFILE";
export const VERA_RUNTIME_DIR_ENV = "VERA_RUNTIME_DIR";
/** Names the deliberate worktree runtime so startup cleanup leaves only it running. */
export const VERA_WORKTREE_RUNTIME_ENV = "VERA_WORKTREE_RUNTIME";

export const DEFAULT_PROFILE_NAME = "default";

/** Rejects anything that would escape the profiles directory. */
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Everything Vera owns on this machine, across every profile. */
export function veraHomeDirectory(home?: string): string {
    if (home !== undefined) return join(home, ".vera");
    const override = process.env[VERA_HOME_ENV]?.trim();
    if (override !== undefined && override.length > 0) return override;
    return join(homedir(), ".vera");
}

/**
 * State that is one picture per machine rather than per installation, so it
 * sits outside every profile and stays in one copy: credentials, and coord's
 * presence store. This is also what makes a profile directory shareable with
 * nothing to strip.
 */
export function veraMachineDirectory(home?: string): string {
    return join(veraHomeDirectory(home), "machine");
}

export function veraProfileName(env = process.env): string {
    const name = env[VERA_PROFILE_ENV]?.trim();
    if (name === undefined || name.length === 0) return DEFAULT_PROFILE_NAME;
    if (!PROFILE_NAME_PATTERN.test(name)) {
        throw new VeraProfileError(
            `${VERA_PROFILE_ENV} must match ${PROFILE_NAME_PATTERN.source}, got "${name}"`,
        );
    }
    return name;
}

/** Config, extensions, skills, and memory: what a second installation varies. */
export function veraProfileDirectory(env = process.env, home?: string): string {
    return join(veraHomeDirectory(home), "profiles", veraProfileName(env));
}

/**
 * State one profile's resident host owns. `VERA_RUNTIME_DIR` stays underneath
 * as the lower-level override for tests and CI; the profile is the hand-driven
 * surface.
 */
export function veraRuntimeDirectory(env = process.env, home?: string): string {
    const override = env[VERA_RUNTIME_DIR_ENV]?.trim();
    if (override !== undefined && override.length > 0) return override;
    return join(veraProfileDirectory(env, home), "runtime");
}

export class VeraProfileError extends Error {}

/** Files the flat layout kept directly under `~/.vera`. */
const LEGACY_ENTRIES = [
    "auth.json",
    "config.json",
    "inbox.db",
    "schedules.db",
    "host.json",
    "preferences.json",
    "pool.json",
    "spawn-consent.json",
    "sessions",
    "extensions",
    "skills",
    "memory",
];

export function legacyLayoutEntries(home?: string): readonly string[] {
    const root = veraHomeDirectory(home);
    return LEGACY_ENTRIES.filter((entry) => existsSync(join(root, entry)));
}

/**
 * Refuses to run against the flat layout rather than reading a tiered path and
 * finding nothing, which presents as missing credentials and missing sessions.
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
    const found = legacyLayoutEntries(home);
    if (found.length === 0) return;
    const machineDirectory = veraMachineDirectory(home);
    const profileDirectory = join(root, "profiles", DEFAULT_PROFILE_NAME);
    const moves = found.map((entry) => {
        const destination = entry === "auth.json" ? machineDirectory : profileDirectory;
        return `  mv ${join(root, entry)} ${destination}/`;
    });
    throw new VeraProfileError(
        `${root} uses the old flat layout and Vera no longer reads it.\n`
        + `Found old entries: ${found.join(", ")}\n`
        + `Run these commands, then start Vera again:\n`
        + `  mkdir -p ${machineDirectory} ${profileDirectory}\n`
        + moves.join("\n"),
    );
}

/** The only names a tiered home owns. */
const KNOWN_ENTRIES = ["machine", "profiles"];

/**
 * Names sitting directly under the home that no tier owns, which is where an
 * extension joining `homedir()` with `.vera` leaves its state. Such a directory
 * is shared by every profile and lost by anyone copying a profile.
 */
export function unrecognisedHomeEntries(home?: string): readonly string[] {
    const root = veraHomeDirectory(home);
    if (!existsSync(root)) return [];
    return readdirSync(root)
        .filter((entry) => !entry.startsWith("."))
        .filter((entry) => !KNOWN_ENTRIES.includes(entry))
        .sort();
}
