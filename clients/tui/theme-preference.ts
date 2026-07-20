import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { TuiThemeName } from "./theme.ts";

export function tuiThemePreferencePath(): string {
    return join(homedir(), ".vera", "tui.json");
}

export function loadTuiThemePreference(
    path = tuiThemePreferencePath(),
): TuiThemeName {
    try {
        const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
        if (typeof value === "object" && value !== null) {
            const theme = Reflect.get(value, "theme");
            if (isTuiThemeName(theme)) {
                return theme;
            }
        }
    } catch {
        // Missing or malformed client preferences must not prevent startup.
    }
    return "default";
}

export function saveTuiThemePreference(
    theme: TuiThemeName,
    path = tuiThemePreferencePath(),
): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify({ theme }, null, 2)}\n`, {
        mode: 0o600,
    });
    renameSync(temporaryPath, path);
}

export function isTuiThemeName(value: unknown): value is TuiThemeName {
    return value === "default"
        || value === "system"
        || value === "orng"
        || value === "palenight"
        || value === "synthwave"
        || value === "nightowl"
        || value === "github";
}
