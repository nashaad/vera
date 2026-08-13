import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const VERA_PROFILE_ENV = "VERA_PROFILE";
export const VERA_RUNTIME_DIR_ENV = "VERA_RUNTIME_DIR";

export const DEFAULT_PROFILE_NAME = "default";

/** Rejects anything that would escape the profiles directory. */
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Everything Vera owns on this machine, across every profile. */
export function veraHomeDirectory(home = homedir()): string {
    return join(home, ".vera");
}

/**
 * Credentials belong to the person and the machine, so they sit outside every
 * profile and stay in one copy. This is what makes a profile directory
 * shareable with nothing to strip.
 */
export function veraUserDirectory(home = homedir()): string {
    return join(veraHomeDirectory(home), "user");
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
export function veraProfileDirectory(env = process.env, home = homedir()): string {
    return join(veraHomeDirectory(home), "profiles", veraProfileName(env));
}

/**
 * State one profile's resident host owns. `VERA_RUNTIME_DIR` stays underneath
 * as the lower-level override for tests and CI; the profile is the hand-driven
 * surface.
 */
export function veraRuntimeDirectory(env = process.env, home = homedir()): string {
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

export function legacyLayoutEntries(home = homedir()): readonly string[] {
    const root = veraHomeDirectory(home);
    return LEGACY_ENTRIES.filter((entry) => existsSync(join(root, entry)));
}

/**
 * Refuses to run against the flat layout rather than reading a tiered path and
 * finding nothing, which presents as missing credentials and missing sessions.
 */
export function assertProfileLayout(home = homedir()): void {
    const found = legacyLayoutEntries(home);
    if (found.length === 0) return;
    const root = veraHomeDirectory(home);
    throw new VeraProfileError(
        `${root} uses the old flat layout and Vera no longer reads it.\n`
        + `Move these into the new layout, then start Vera again:\n`
        + `  auth.json                  -> ${veraUserDirectory(home)}/auth.json\n`
        + `  everything else            -> ${join(root, "profiles", DEFAULT_PROFILE_NAME)}/\n`
        + `Found: ${found.join(", ")}`,
    );
}
