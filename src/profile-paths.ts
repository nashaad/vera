import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const VERA_HOME_ENV = "VERA_HOME";

export const DEFAULT_PROFILE_NAME = "default";

export function veraHomeDirectory(home?: string): string {
    if (home !== undefined) return join(home, ".vera");
    const override = process.env[VERA_HOME_ENV]?.trim();
    if (override !== undefined && override.length > 0) return override;
    return join(homedir(), ".vera");
}

export function veraMachineDirectory(home?: string): string {
    return join(veraHomeDirectory(home), "machine");
}

export function veraProfileDirectory(_env = process.env, home?: string): string {
    return veraHomeDirectory(home);
}

export function veraRuntimeDirectory(_env = process.env, home?: string): string {
    return join(veraHomeDirectory(home), "runtime");
}

export class VeraProfileError extends Error {}

export function legacyProfileLayoutEntries(home?: string): readonly string[] {
    const root = veraHomeDirectory(home);
    return existsSync(join(root, "profiles")) ? ["profiles"] : [];
}

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

export const HOME_OWNED_ROOT_ENTRIES = [
    "machine",
    "runtime",
    "config.json",
    "pool.json",
    "preferences.json",
    "tui.json",
    "extensions",
    "skills",
    "memory",
    "agents",
] as const;

export function unrecognisedHomeEntries(home?: string): readonly string[] {
    const root = veraHomeDirectory(home);
    if (!existsSync(root)) return [];
    return readdirSync(root)
        .filter((entry) => !entry.startsWith("."))
        .filter((entry) =>
            !(HOME_OWNED_ROOT_ENTRIES as readonly string[]).includes(entry)
        )
        .sort();
}

export function legacyLayoutEntries(home?: string): readonly string[] {
    return legacyProfileLayoutEntries(home);
}
