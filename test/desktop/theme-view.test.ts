import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { readThemeView, storeThemeView } from "../../clients/ui/src/theme/storage.ts";

test("@core the theme view survives a fresh process using real web storage", async () => {
    const folder = mkdtempSync(join(tmpdir(), "vera-theme-view-"));
    try {
        const bundle = await Bun.build({
            entrypoints: [join(import.meta.dir, "../../clients/ui/src/theme/storage.ts")],
            target: "node",
            format: "esm",
        });
        expect(bundle.success).toBe(true);
        const module = join(folder, "storage.mjs");
        writeFileSync(module, await bundle.outputs[0]!.text());
        const script = `import { readThemeView, storeThemeView } from ${JSON.stringify(pathToFileURL(module).href)};
            if (process.argv[1] === "save") storeThemeView("tile", localStorage);
            if (process.argv[1] === "invalid") localStorage.setItem("vera.theme.view", "crow");
            if (process.argv[1] === "list") storeThemeView("list", localStorage);
            console.log(readThemeView(localStorage));`;
        const run = (mode: string): string => execFileSync("node", [
            "--experimental-webstorage", `--localstorage-file=${join(folder, "localstorage")}`,
            "--input-type=module", "-e", script, mode,
        ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
        expect(run("read")).toBe("tile");
        expect(run("save")).toBe("tile");
        expect(run("read")).toBe("tile");
        expect(run("invalid")).toBe("tile");
        expect(run("list")).toBe("list");
        expect(run("read")).toBe("list");
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});

test("theme view falls back when web storage is unavailable", () => {
    const storage = {
        getItem(): never { throw new Error("unavailable"); },
        setItem(): never { throw new Error("unavailable"); },
        removeItem(): never { throw new Error("unavailable"); },
    };
    expect(readThemeView(storage)).toBe("tile");
    expect(() => storeThemeView("tile", storage)).not.toThrow();
});
