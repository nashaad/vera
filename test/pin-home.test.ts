import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { selectedVeraHome } from "../src/profile-paths.ts";
import { defaultSessionPath } from "../src/store/session-store.ts";
import { TEST_TEMP_ROOT, TEST_USER_HOME, TEST_VERA_HOME } from "./pin-home.ts";

test("the test process selects its own temporary Vera home", () => {
    expect(process.env.VERA_HOME).toBe(TEST_VERA_HOME);
    expect(process.env.VERA_TEST_HOME).toBe(TEST_VERA_HOME);
    expect(selectedVeraHome()).toBe(TEST_VERA_HOME);
    expect(relative(TEST_TEMP_ROOT.path, TEST_VERA_HOME)).toBe("home");
    expect(selectedVeraHome()).not.toBe(join(homedir(), ".vera"));
    expect(defaultSessionPath("probe")).toBe(join(TEST_VERA_HOME, "runtime", "sessions", "probe.jsonl"));
});

test("@core Bun children inherit the current test environment unless env is explicit", async () => {
    const previousProbe = process.env.VERA_SPAWN_ENV_PROBE;
    process.env.VERA_SPAWN_ENV_PROBE = "after-preload";
    const command = [
        "/bin/sh",
        "-c",
        'printf "%s\\n%s\\n%s\\n" "${VERA_HOME-}" "${HOME-}" "${VERA_SPAWN_ENV_PROBE-}"',
    ];
    const pinned = `${TEST_VERA_HOME}\n${TEST_USER_HOME}\nafter-preload\n`;
    const explicitEnv = {
        VERA_HOME: "/child-vera-home",
        HOME: "/child-user-home",
        VERA_SPAWN_ENV_PROBE: "explicit",
    };
    const explicit = "/child-vera-home\n/child-user-home\nexplicit\n";
    const empty = "\n\n\n";

    try {
        const syncCases = [
            { start: () => Bun.spawnSync(command), expected: pinned },
            { start: () => Bun.spawnSync(command, {}), expected: pinned },
            { start: () => Bun.spawnSync(command, Object.freeze({ env: undefined })), expected: pinned },
            { start: () => Bun.spawnSync({ cmd: command }), expected: pinned },
            { start: () => Bun.spawnSync(Object.freeze({ cmd: command, env: undefined })), expected: pinned },
            { start: () => Bun.spawnSync(command, { env: explicitEnv }), expected: explicit },
            { start: () => Bun.spawnSync({ cmd: command, env: explicitEnv }), expected: explicit },
            { start: () => Bun.spawnSync(command, { env: {} }), expected: empty },
        ];
        for (const { start, expected } of syncCases) {
            const child = start();
            expect(child.exitCode).toBe(0);
            expect(child.stdout.toString()).toBe(expected);
        }

        const asyncCases = [
            { start: () => Bun.spawn(command), expected: pinned },
            { start: () => Bun.spawn(command, {}), expected: pinned },
            { start: () => Bun.spawn(command, Object.freeze({ env: undefined })), expected: pinned },
            { start: () => Bun.spawn({ cmd: command }), expected: pinned },
            { start: () => Bun.spawn(Object.freeze({ cmd: command, env: undefined })), expected: pinned },
            { start: () => Bun.spawn(command, { env: explicitEnv }), expected: explicit },
            { start: () => Bun.spawn({ cmd: command, env: explicitEnv }), expected: explicit },
            { start: () => Bun.spawn({ cmd: command, env: {} }), expected: empty },
        ];
        for (const { start, expected } of asyncCases) {
            const child = start();
            const output = await new Response(child.stdout).text();
            expect(await child.exited).toBe(0);
            expect(output).toBe(expected);
        }
    } finally {
        if (previousProbe === undefined) delete process.env.VERA_SPAWN_ENV_PROBE;
        else process.env.VERA_SPAWN_ENV_PROBE = previousProbe;
    }
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
