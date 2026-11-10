import { expect, test } from "bun:test";
import { dirname, resolve } from "node:path";

async function staticClosure(entry: string): Promise<Set<string>> {
    const visited = new Set<string>();
    const pending = [resolve(entry)];
    while (pending.length > 0) {
        const path = pending.pop()!;
        if (visited.has(path)) continue;
        visited.add(path);
        const source = (await Bun.file(path).text()).replace(/^#![^\n]*/, "");
        const imports = new Bun.Transpiler({ loader: path.endsWith("x") ? "tsx" : "ts" }).scanImports(source);
        for (const item of imports) {
            if (item.kind !== "import-statement" || !item.path.startsWith(".")) continue;
            const target = resolve(dirname(path), item.path);
            const candidates = [target, `${target}.ts`, `${target}.tsx`, resolve(target, "index.ts")];
            for (const candidate of candidates) {
                if (await Bun.file(candidate).exists()) {
                    pending.push(candidate);
                    break;
                }
            }
        }
    }
    return visited;
}

test("@core config and idle entries keep deferred implementations out of their static imports", async () => {
    for (const entry of ["src/config.ts", "clients/host/main.ts", "clients/host/session-worker.ts"]) {
        const closure = await staticClosure(entry);
        expect(closure.has(resolve("src/tools/web-fetch.ts"))).toBe(false);
        expect(closure.has(resolve("src/tools/html-to-markdown.ts"))).toBe(false);
        expect(closure.has(resolve("src/tools/diff-presentation.ts"))).toBe(false);
        if (entry === "src/config.ts") {
            const toolFiles = [...closure].filter((path) => path.startsWith(`${resolve("src/tools")}/`));
            expect(toolFiles).toEqual([resolve("src/tools/tool-result-limit.ts")]);
            expect(closure.has(resolve("src/tools/execute.ts"))).toBe(false);
            expect(closure.has(resolve("src/engine/override-rows.ts"))).toBe(false);
            expect(closure.has(resolve("src/extensions/manager.ts"))).toBe(false);
        }
    }
});

test("@core session workers do not start the host parking timer", async () => {
    const source = await Bun.file("src/host/session-host.ts").text();
    expect(source).toMatch(/if \(options\.sessionWorker !== true\)\s*\{\s*parkIdleTimer = setInterval\(/);
});
