import { expect, test } from "bun:test";
import { basename } from "node:path";

test("product code does not read VERA_WORKER", async () => {
    const hits: string[] = [];
    for await (const path of new Bun.Glob("src/**/*.ts").scan({
        cwd: process.cwd(),
    })) {
        const source = await Bun.file(path).text();
        if (/VERA_WORKER(?!_EXTENSIONS)/.test(source)) hits.push(path);
    }
    for await (const path of new Bun.Glob("clients/**/*.ts").scan({
        cwd: process.cwd(),
    })) {
        const source = await Bun.file(path).text();
        if (/VERA_WORKER(?!_EXTENSIONS)/.test(source)) hits.push(path);
    }
    expect(hits).toEqual([]);
});

test("runHeadlessLoop is imported only at the three structural call sites", async () => {
    const importers: string[] = [];
    for await (const path of new Bun.Glob("src/**/*.ts").scan({
        cwd: process.cwd(),
    })) {
        const source = await Bun.file(path).text();
        if (basename(path) === "run-turn.ts") continue;
        if (!/import\s*\{[^}]*\brunHeadlessLoop\b/.test(source)) continue;
        importers.push(basename(path));
    }
    expect(importers.sort()).toEqual([
        "agent-registry.ts",
        "agent.ts",
        "entry.ts",
    ]);
});
