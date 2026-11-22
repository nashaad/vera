import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const NOTES_OFFER = /notes_offer|notesOffer|NotesOffer/;

function mentions(directory: string): string[] {
    const found: string[] = [];
    for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync(join(ROOT, directory))) {
        if (NOTES_OFFER.test(readFileSync(join(ROOT, directory, file), "utf8"))) found.push(`${directory}/${file}`);
    }
    return found.sort();
}

test("@core only the desktop window asks for the notes offer", () => {
    for (const directory of [
        "clients/tui",
        "clients/cli",
        "clients/stdio",
        "clients/host",
        "clients/shared",
        "clients/annex",
        "src/sdk",
    ]) {
        expect(mentions(directory)).toEqual([]);
    }
    expect(mentions("clients/desktop/src")).toEqual([
        "clients/desktop/src/main.ts",
        "clients/desktop/src/preload.ts",
    ]);
});

function callArguments(source: string, name: string): string[][] {
    const calls: string[][] = [];
    let from = source.indexOf(`${name}(`);
    while (from !== -1) {
        let depth = 0;
        let current = "";
        const args: string[] = [];
        for (let index = from + name.length; index < source.length; index += 1) {
            const char = source[index]!;
            if (char === "(" || char === "[" || char === "{") {
                depth += 1;
                if (depth === 1) continue;
            }
            if (char === ")" || char === "]" || char === "}") {
                depth -= 1;
                if (depth === 0) break;
            }
            if (char === "," && depth === 1) {
                args.push(current.trim());
                current = "";
                continue;
            }
            current += char;
        }
        if (current.trim().length > 0) args.push(current.trim());
        calls.push(args);
        from = source.indexOf(`${name}(`, from + 1);
    }
    return calls;
}

test("@core the terminal and stdio clients create sessions without the notes argument", () => {
    for (const file of ["clients/tui/main.ts", "clients/tui/configured-agent-client.ts", "clients/stdio/process.ts"]) {
        const calls = callArguments(readFileSync(join(ROOT, file), "utf8"), "createAgentThroughHost");
        expect(calls.length).toBeGreaterThan(0);
        for (const args of calls) {
            if (args[0] === "socketPath: string") continue;
            expect(args.length).toBeLessThanOrEqual(7);
            if (args.length >= 6) expect(args[5]).toBe("undefined");
        }
    }
});
