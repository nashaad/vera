import { expect, test } from "bun:test";
import { dirname, resolve } from "node:path";

test("@core host modules do not import the CLI entry", async () => {
    const cliEntry = resolve("clients/cli/main.ts");
    const violations: string[] = [];
    const files = new Bun.Glob("**/*.{ts,tsx,js,jsx}");
    for await (const file of files.scan({ cwd: "clients/host" })) {
        const path = resolve("clients/host", file);
        const source = (await Bun.file(path).text()).replace(/^#![^\n]*/, "");
        const imports = new Bun.Transpiler({ loader: file.endsWith("x") ? "tsx" : "ts" }).scanImports(source);
        for (const entry of imports) {
            if (!entry.path.startsWith(".")) continue;
            const target = resolve(dirname(path), entry.path);
            if (target === cliEntry || `${target}.ts` === cliEntry) {
                violations.push(file);
            }
        }
    }
    expect(violations).toEqual([]);
});
