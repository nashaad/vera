import { expect, test } from "bun:test";
import { dirname, normalize } from "node:path";

/**
 * TUI pieces general enough to be used outside Vera. Their whole import
 * closure must stay inside `clients/tui/` and OpenTUI, so lifting the set out
 * is a move rather than a rewrite. A colour constant living beside session
 * state is enough to pull `src/engine/protocol.ts` in behind it.
 */
const LIFTABLE = [
    "clients/tui/palette.ts",
    "clients/tui/theme.ts",
    "clients/tui/single-line-editor.ts",
    "clients/tui/dialog-chrome.ts",
];

/** Resolved specifier, or undefined for a package or a data file. */
function resolveImport(from: string, specifier: string): string | undefined {
    if (!specifier.startsWith(".")) {
        return undefined;
    }
    return normalize(`${dirname(from)}/${specifier}`);
}

async function importsOf(path: string): Promise<string[]> {
    const source = await Bun.file(path).text();
    return [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!);
}

test("the liftable TUI components reach no engine module", async () => {
    const seen = new Set<string>();
    const queue = [...LIFTABLE];
    const reached: string[] = [];

    while (queue.length > 0) {
        const path = queue.pop()!;
        if (seen.has(path)) continue;
        seen.add(path);

        for (const specifier of await importsOf(path)) {
            const resolved = resolveImport(path, specifier);
            if (resolved === undefined || resolved.endsWith(".json")) {
                continue;
            }
            if (!resolved.startsWith("clients/tui/")) {
                reached.push(`${path} -> ${specifier}`);
                continue;
            }
            queue.push(resolved);
        }
    }

    expect(reached).toEqual([]);
    // The walk is only meaningful if it actually followed the graph.
    expect(seen.size).toBeGreaterThanOrEqual(LIFTABLE.length);
});
