import { existsSync, readFileSync, readdirSync } from "node:fs";
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

export function veraMachineDirectoryIn(veraHome: string): string {
    return join(veraHome, "machine");
}

export function veraMachineDirectory(home?: string): string {
    return veraMachineDirectoryIn(veraHomeDirectory(home));
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

export const EXTENSION_DATA_DIRECTORY = "extension-data";

export const HOME_OWNED_ROOT_ENTRIES = [
    "machine",
    EXTENSION_DATA_DIRECTORY,
    "runtime",
    "config.json",
    "pool.json",
    "preferences.json",
    "tui.json",
    "tips.json",
    "extensions",
    "extensions.json",
    "skills",
    "hooks",
    "memory",
    "agents",
] as const;

/**
 * Ids of the extensions installed in this home. Extension storage at the
 * profile tier is `<home>/<id>`, so these directories are owned too.
 */
export function installedExtensionIds(home?: string): readonly string[] {
    return installedExtensionIdsIn(veraHomeDirectory(home));
}

export function installedExtensionIdsIn(veraHome: string): readonly string[] {
    const directory = join(veraHome, "extensions");
    let entries: string[];
    try {
        entries = readdirSync(directory);
    } catch {
        return [];
    }
    const ids = new Set<string>();
    for (const entry of entries) {
        if (entry === ".managed") {
            for (const managed of readManagedExtensionIds(join(directory, entry))) {
                ids.add(managed);
            }
            continue;
        }
        const id = readExtensionManifestId(join(directory, entry));
        if (id !== undefined) ids.add(id);
    }
    return [...ids].sort();
}

function readManagedExtensionIds(directory: string): readonly string[] {
    try {
        return readdirSync(directory)
            .filter((entry) => entry.endsWith(".json"))
            .map((entry) => entry.slice(0, -".json".length));
    } catch {
        return [];
    }
}

function readExtensionManifestId(directory: string): string | undefined {
    let text: string;
    try {
        text = readFileSync(join(directory, "vera.extension.json"), "utf8");
    } catch {
        return undefined;
    }
    try {
        const id: unknown = (JSON.parse(text) as { id?: unknown }).id;
        return typeof id === "string" && id.length > 0 ? id : undefined;
    } catch {
        return undefined;
    }
}

export function unrecognisedHomeEntries(home?: string): readonly string[] {
    const root = veraHomeDirectory(home);
    if (!existsSync(root)) return [];
    const owned = new Set<string>([
        ...HOME_OWNED_ROOT_ENTRIES,
        ...installedExtensionIds(home),
    ]);
    return readdirSync(root)
        .filter((entry) => !entry.startsWith("."))
        .filter((entry) => !owned.has(entry))
        .sort();
}

export function legacyLayoutEntries(home?: string): readonly string[] {
    return legacyProfileLayoutEntries(home);
}
