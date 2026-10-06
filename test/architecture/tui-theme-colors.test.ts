import { expect, test } from "bun:test";

test("TUI palette literals live in the declarative theme catalog", async () => {
    const glob = new Bun.Glob("clients/tui/**/*.ts");
    const violations: string[] = [];

    for await (const path of glob.scan({ cwd: import.meta.dir + "/../.." })) {
        let source = await Bun.file(
            new URL(`../../${path}`, import.meta.url),
        ).text();
        if (path === "clients/tui/theme.ts") {
            source = source
                .replace('mixHex(theme.background, "#000000", 0.45)', "")
                .replaceAll("must be a color like #A1B2C3", "")
                .replace(/export const FALLBACK_TUI_THEME: TuiTheme = Object\.freeze\(\{[^}]*\}\);/, "");
        }
        if (/#[0-9a-f]{3,8}\b/i.test(source)) {
            violations.push(path);
        }
    }

    expect(violations).toEqual([]);
});
