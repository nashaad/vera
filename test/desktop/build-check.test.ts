import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { desktopBuildMismatch, type BuildCheckSources } from "../../clients/desktop/src/build-check.ts";
import { DESKTOP_BUILD_ID_SYMBOL, desktopClientBuildId } from "../../clients/desktop/src/client-build.ts";
import { bootsFromSource } from "../../clients/desktop/src/vera-command.ts";

function sources(overrides: Partial<BuildCheckSources>): BuildCheckSources {
    return { env: {}, clientBuildId: () => "old", installedBuildId: () => "new", ...overrides };
}

test("@core a desktop built before the installed release is refused", () => {
    expect(desktopBuildMismatch(sources({}))).toEqual({ clientBuildId: "old", installedBuildId: "new" });
});

test("@core a desktop on the installed build is not refused", () => {
    expect(desktopBuildMismatch(sources({ installedBuildId: () => "old" }))).toBeUndefined();
});

test("@core a desktop with no build id or no installed release is not refused", () => {
    expect(desktopBuildMismatch(sources({ clientBuildId: () => undefined }))).toBeUndefined();
    expect(desktopBuildMismatch(sources({ installedBuildId: () => undefined }))).toBeUndefined();
});

test("@core a desktop that boots Vera from source skips the check", () => {
    const env = { VERA_DESKTOP_DEV_CLI: "/checkout/clients/cli/main.ts" };
    expect(bootsFromSource(env)).toBe(true);
    expect(desktopBuildMismatch(sources({ env }))).toBeUndefined();
    expect(bootsFromSource({ VERA_DESKTOP_DEV_CLI: "  " })).toBe(false);
    expect(bootsFromSource({})).toBe(false);
});

test("an unbundled desktop has no build id", () => {
    expect(desktopClientBuildId()).toBeUndefined();
});

test("@core a bundle built with the stamp reports it as the desktop build id", async () => {
    const out = mkdtempSync(join(tmpdir(), "vera-desktop-stamp-"));
    try {
        const result = await Bun.build({
            entrypoints: [join(import.meta.dir, "../../clients/desktop/src/client-build.ts")],
            outdir: out,
            target: "node",
            define: { [DESKTOP_BUILD_ID_SYMBOL]: JSON.stringify("stamped-build") },
        });
        expect(result.success).toBe(true);
        const bundled = join(out, "client-build.js");
        expect(readFileSync(bundled, "utf8")).toContain("stamped-build");
        const loaded = (await import(bundled)) as { desktopClientBuildId(): string | undefined };
        expect(loaded.desktopClientBuildId()).toBe("stamped-build");
    } finally {
        rmSync(out, { recursive: true, force: true });
    }
});
