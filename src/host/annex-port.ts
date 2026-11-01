import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// "VERA" on a phone keypad.
export const DEFAULT_ANNEX_PORT = 8372;

export function annexPortPath(veraHome: string): string {
    return join(veraHome, "runtime", "annex.json");
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
