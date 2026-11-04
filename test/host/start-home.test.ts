import { expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");

test("a host with one home writes nothing under the default home", async () => {
    // /tmp keeps the derived socket path short enough for a Unix socket.
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    const fakeHome = join(root, "user");
    const home = join(root, "vera");
    mkdirSync(fakeHome);
    mkdirSync(home);
    // The child has to find a packed release the same way a real install does.
    const releaseCurrent = join(
        repoRoot,
        ".vera-test-user",
        ".local",
        "share",
        "vera",
        "current",
    );
    mkdirSync(join(fakeHome, ".local", "share", "vera"), { recursive: true });
    symlinkSync(releaseCurrent, join(fakeHome, ".local", "share", "vera", "current"));

    const scriptPath = join(root, "start.ts");
    writeFileSync(
        scriptPath,
        `
        import { startResidentHost } from ${
            JSON.stringify(join(repoRoot, "src/host/runtime.ts"))
        };
        import { FauxAdapter } from ${
            JSON.stringify(join(repoRoot, "test/support/faux-adapter.ts"))
        };
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
            },
            home: ${JSON.stringify(home)},
            createAdapter: () => new FauxAdapter([]),
        });
        await host.close();
        console.log("closed");
        `,
    );

    const env: Record<string, string | undefined> = {
        ...process.env,
        HOME: fakeHome,
    };
    delete env.VERA_HOME;
    delete env.VERA_POOL_FILE;
    delete env.VERA_RUNTIME_DIR;
    delete env.VERA_PROFILE;

    try {
        const child = Bun.spawn([process.execPath, scriptPath], {
            cwd: repoRoot,
            env,
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);

        expect(stderr).toBe("");
        expect(stdout).toContain("closed");
        expect(exitCode).toBe(0);

        expect(existsSync(join(fakeHome, ".vera"))).toBe(false);
        expect(existsSync(join(home, "runtime", "logs", "host.jsonl"))).toBe(true);
        expect(existsSync(join(home, "runtime", "inbox.db"))).toBe(true);
        expect(existsSync(join(home, "runtime", "schedules.db"))).toBe(true);
        expect(existsSync(join(home, "extension-data"))).toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("explicit paths with no home are refused before writing", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-"));
    const fakeHome = join(root, "user");
    const paths = join(root, "paths");
    mkdirSync(fakeHome);
    mkdirSync(paths);

    const scriptPath = join(root, "start.ts");
    writeFileSync(
        scriptPath,
        `
        import { startResidentHost } from ${
            JSON.stringify(join(repoRoot, "src/host/runtime.ts"))
        };
        import { FauxAdapter } from ${
            JSON.stringify(join(repoRoot, "test/support/faux-adapter.ts"))
        };
        await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
            },
            socketPath: ${JSON.stringify(join(paths, "host.sock"))},
            lockPath: ${JSON.stringify(join(paths, "host.json"))},
            sessionDirectory: ${JSON.stringify(join(paths, "sessions"))},
            eventLogDirectory: ${JSON.stringify(join(paths, "logs"))},
            createAdapter: () => new FauxAdapter([]),
        });
        console.log("started");
        `,
    );

    const env: Record<string, string | undefined> = {
        ...process.env,
        HOME: fakeHome,
    };
    delete env.VERA_HOME;
    delete env.VERA_POOL_FILE;
    delete env.VERA_RUNTIME_DIR;
    delete env.VERA_PROFILE;

    try {
        // Spawn outside the repo so Bun does not load .env.test, which sets VERA_HOME.
        const child = Bun.spawn([process.execPath, scriptPath], {
            cwd: root,
            env,
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);

        expect(exitCode).not.toBe(0);
        expect(stdout).not.toContain("started");
        expect(stderr).toContain("explicit paths but no home");
        expect(stderr).toContain("VERA_HOME");
        expect(existsSync(join(fakeHome, ".vera"))).toBe(false);
        expect(existsSync(join(paths, "host.sock"))).toBe(false);
        expect(existsSync(join(paths, "sessions"))).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
