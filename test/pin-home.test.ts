import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { selectedVeraHome } from "../src/profile-paths.ts";
import { defaultSessionPath } from "../src/store/session-store.ts";
import { TEST_TEMP_ROOT, TEST_VERA_HOME } from "./pin-home.ts";

test("the test process selects its own temporary Vera home", () => {
    expect(process.env.VERA_HOME).toBe(TEST_VERA_HOME);
    expect(process.env.VERA_TEST_HOME).toBe(TEST_VERA_HOME);
    expect(selectedVeraHome()).toBe(TEST_VERA_HOME);
    expect(relative(TEST_TEMP_ROOT.path, TEST_VERA_HOME)).toBe("home");
    expect(selectedVeraHome()).not.toBe(join(homedir(), ".vera"));
    expect(defaultSessionPath("probe")).toBe(join(TEST_VERA_HOME, "runtime", "sessions", "probe.jsonl"));
});

test("the preload pins unset, empty, and inherited Vera homes away from the default home", () => {
    const root = mkdtempSync(join(tmpdir(), "pin-home-"));
    const base = join(root, "roots");
    mkdirSync(base);
    const userHome = homedir();
    const defaultHome = join(userHome, ".vera");
    const pin = fileURLToPath(new URL("./pin-home.ts", import.meta.url));
    const profilePaths = new URL("../src/profile-paths.ts", import.meta.url).href;
    try {
        const homes = new Set<string>();
        for (const inherited of [undefined, "", defaultHome]) {
            const env: Record<string, string | undefined> = { ...process.env, HOME: userHome, VERA_TEST_TEMP_BASE: base };
            if (inherited === undefined) delete env.VERA_HOME;
            else env.VERA_HOME = inherited;
            const probe = Bun.spawnSync([process.execPath, "--preload", pin, "-e", `
                import { selectedVeraHome } from ${JSON.stringify(profilePaths)};
                process.stdout.write(JSON.stringify({ selected: selectedVeraHome(), pinned: process.env.VERA_TEST_HOME }));
            `], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
            expect(probe.exitCode, probe.stderr.toString()).toBe(0);
            const result = JSON.parse(probe.stdout.toString()) as { selected: string; pinned: string };
            expect(result.selected).toBe(result.pinned);
            expect(result.selected).not.toBe(defaultHome);
            expect(relative(base, result.selected)).not.toStartWith("..");
            homes.add(result.selected);
        }
        expect(homes.size).toBe(3);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
