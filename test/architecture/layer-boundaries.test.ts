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

    expect(owners).toEqual(["inbound-frame-router.ts"]);
});
