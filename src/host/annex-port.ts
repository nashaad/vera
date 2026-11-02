import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// "VERA" on a phone keypad. Only the default Vera home asks for it.
export const DEFAULT_ANNEX_PORT = 8372;

export interface WantedAnnexPort {
    // undefined means any free port will do.
    readonly port: number | undefined;
    readonly saved: boolean;
}

export function annexPortPath(veraHome: string): string {
    return join(veraHome, "runtime", "annex.json");
}

// Any other home never asks for 8372, even with it saved, so it cannot keep
// the default home off its port.
export function wantedAnnexPort(veraHome: string, defaultHome: string): WantedAnnexPort {
    const isDefaultHome = resolve(veraHome) === resolve(defaultHome);
    const saved = readSavedAnnexPort(veraHome);
    if (saved !== undefined && (isDefaultHome || saved !== DEFAULT_ANNEX_PORT)) {
        return { port: saved, saved: true };
    }
    return {
        port: isDefaultHome ? DEFAULT_ANNEX_PORT : undefined,
        saved: false,
    };
}

export function readSavedAnnexPort(veraHome: string): number | undefined {
    let text: string;
    try {
        text = readFileSync(annexPortPath(veraHome), "utf8");
    } catch {
        return undefined;
    }
    try {
        const port: unknown = (JSON.parse(text) as { port?: unknown }).port;
        return isListenPort(port) ? port : undefined;
    } catch {
        return undefined;
    }
}

export function saveAnnexPort(veraHome: string, port: number): void {
    const path = annexPortPath(veraHome);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ port }, null, 2)}\n`);
    renameSync(temporary, path);
}

function isListenPort(value: unknown): value is number {
    return typeof value === "number"
        && Number.isInteger(value)
        && value > 0
        && value < 65_536;
}
