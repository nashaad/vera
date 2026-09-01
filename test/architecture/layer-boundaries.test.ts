import { expect, test } from "bun:test";
import { basename } from "node:path";

test("engine source does not import clients", async () => {
    const sourceFiles = new Bun.Glob("src/**/*.ts").scan({
        cwd: process.cwd(),
        absolute: true,
    });

    for await (const path of sourceFiles) {
        const source = await Bun.file(path).text();
        expect(source, path).not.toMatch(
            /(?:from\s*|import\s*(?:\(\s*)?)["'][^"']*clients\//,
        );
    }
});

test("the inbound router is the only engine endpoint receiver", async () => {
    const sourceFiles = new Bun.Glob("src/engine/**/*.ts").scan({
        cwd: process.cwd(),
        absolute: true,
    });
    const owners: string[] = [];

    for await (const path of sourceFiles) {
        const source = await Bun.file(path).text();
        const receives = source.match(/\bendpoint\.receive\(/g) ?? [];
        owners.push(...receives.map(() => basename(path)));
    }

    expect(owners).toEqual(["inbound-command-router.ts"]);
});

test("the TUI reaches agents only through its client interface", async () => {
    const files = ["clients/tui/main.ts"];
    for await (const path of new Bun.Glob("clients/tui/main/**/*.ts").scan()) {
        files.push(path);
    }

    for (const path of files) {
        const source = await Bun.file(path).text();
        expect(source, path).not.toContain("engine/run-turn");
        expect(source, path).not.toContain("engine/message-channel");
        expect(source, path).not.toContain("providers/configured");
    }
});
