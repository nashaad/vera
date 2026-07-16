import { expect, test } from "bun:test";

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
