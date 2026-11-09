import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { candidateHomePath, runDevTui } from "../../scripts/dev-tui.ts";
import { processIsAlive } from "../../src/host/process-identity.ts";
import { acquireHostStartupClaim } from "../../src/host/startup-claim.ts";
import { testTempBase } from "../support/temp-root.ts";

test("dev:tui --stop reports a live recorded session process when the host lock is absent", async () => {
    const root = mkdtempSync(join(testTempBase(), "dev-stop-"));
    const home = candidateHomePath(process.cwd(), root);
    const workers = join(home, "runtime", "workers");
    mkdirSync(workers, { recursive: true });
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000);"], {
        env: { VERA_HOME: home, VERA_DEV_INSTANCE: "hsplit9 dev" },
        stdout: "ignore",
        stderr: "ignore",
    });
    const messages: string[] = [];
    try {
        writeFileSync(join(workers, "w0.json"), JSON.stringify({
            id: "w0",
            pid: child.pid,
            started_at: new Date().toISOString(),
        }));
        const code = await runDevTui(["--stop"], process.cwd(), {
            temporaryRoot: root,
            stderr: { write: (message) => messages.push(message) },
        });
        expect(code).toBe(0);
        expect(messages.join("")).toBe(`Stopped session process PID ${child.pid}.\n`);
        await child.exited;
        expect(processIsAlive(child.pid)).toBe(false);
    } finally {
        child.kill("SIGTERM");
        await child.exited;
        rmSync(root, { recursive: true, force: true });
    }
});

test("dev:tui --stop keeps its no-host message for an empty home", async () => {
    const root = mkdtempSync(join(testTempBase(), "dev-stop-empty-"));
    const messages: string[] = [];
    try {
        const code = await runDevTui(["--stop"], process.cwd(), {
            temporaryRoot: root,
            stderr: { write: (message) => messages.push(message) },
        });
        expect(code).toBe(0);
        expect(messages.join("")).toBe("No development instance host is running.\n");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("dev:tui --stop refuses an unverified session process without signalling it", async () => {
    const root = mkdtempSync(join(testTempBase(), "dev-stop-unverified-"));
    const home = candidateHomePath(process.cwd(), root);
    const workers = join(home, "runtime", "workers");
    mkdirSync(workers, { recursive: true });
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000);"], {
        env: { VERA_HOME: home, VERA_DEV_INSTANCE: "hsplit9 dev" },
        stdout: "ignore",
        stderr: "ignore",
    });
    try {
        writeFileSync(join(workers, "w0.json"), JSON.stringify({
            id: "w0", pid: child.pid, started_at: new Date().toISOString(),
        }));
        writeFileSync(join(root, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
        const runner = Bun.spawn([process.execPath, "-e", [
            "import { runDevTui } from './scripts/dev-tui.ts';",
            "process.exitCode = await runDevTui(['--stop'], process.cwd(), { temporaryRoot: process.env.TEST_TEMPORARY_ROOT });",
        ].join(" ")], {
            cwd: process.cwd(),
            env: { ...process.env, PATH: `${root}:${process.env.PATH}`, TEST_TEMPORARY_ROOT: root },
            stdout: "ignore",
            stderr: "pipe",
        });
        try {
            const code = await Promise.race([runner.exited, Bun.sleep(2_000).then(() => null)]);
            expect(code).toBe(1);
            const messages = await new Response(runner.stderr).text();
            expect(messages).toContain(`Could not confirm session process PID ${child.pid} stopped.`);
        } finally {
            runner.kill("SIGTERM");
            await runner.exited;
        }
        expect(child.exitCode).toBeNull();
        process.kill(child.pid, 0);
    } finally {
        child.kill("SIGTERM");
        await child.exited;
        rmSync(root, { recursive: true, force: true });
    }
});

test("dev:tui --stop reports a stopped session process when another cannot be verified", async () => {
    const root = mkdtempSync(join(testTempBase(), "dev-stop-partial-"));
    const home = candidateHomePath(process.cwd(), root);
    const workers = join(home, "runtime", "workers");
    mkdirSync(workers, { recursive: true });
    const children = [0, 1].map(() => Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000);"], {
        env: { VERA_HOME: home, VERA_DEV_INSTANCE: "hsplit9 dev" },
        stdout: "ignore",
        stderr: "ignore",
    }));
    try {
        for (const [index, child] of children.entries()) {
            writeFileSync(join(workers, `w${index}.json`), JSON.stringify({
                id: `w${index}`, pid: child.pid, started_at: new Date().toISOString(),
            }));
        }
        writeFileSync(join(root, "ps"), [
            "#!/bin/sh",
            `if [ "$2" = "${children[1]!.pid}" ]; then exit 1; fi`,
            "exec /bin/ps \"$@\"",
            "",
        ].join("\n"), { mode: 0o755 });
        const runner = Bun.spawn([process.execPath, "-e", [
            "import { runDevTui } from './scripts/dev-tui.ts';",
            "process.exitCode = await runDevTui(['--stop'], process.cwd(), { temporaryRoot: process.env.TEST_TEMPORARY_ROOT });",
        ].join(" ")], {
            cwd: process.cwd(),
            env: { ...process.env, PATH: `${root}:${process.env.PATH}`, TEST_TEMPORARY_ROOT: root },
            stdout: "ignore",
            stderr: "pipe",
        });
        try {
            const code = await Promise.race([runner.exited, Bun.sleep(2_000).then(() => null)]);
            expect(code).toBe(1);
            const messages = await new Response(runner.stderr).text();
            expect(messages).toContain(`Stopped session process PID ${children[0]!.pid}.`);
            expect(messages).toContain(`Could not confirm session process PID ${children[1]!.pid} stopped.`);
            await children[0]!.exited;
            expect(processIsAlive(children[0]!.pid)).toBe(false);
            expect(processIsAlive(children[1]!.pid)).toBe(true);
        } finally {
            runner.kill("SIGTERM");
            await runner.exited;
        }
    } finally {
        for (const child of children) child.kill("SIGTERM");
        await Promise.all(children.map((child) => child.exited));
        rmSync(root, { recursive: true, force: true });
    }
});

test("dev:tui --stop refuses an empty home while startup holds the claim", async () => {
    const root = mkdtempSync(join(testTempBase(), "dev-stop-starting-"));
    const home = candidateHomePath(process.cwd(), root);
    const claim = await acquireHostStartupClaim({ path: join(home, "runtime", "host.sock.starting") });
    const messages: string[] = [];
    try {
        const code = await runDevTui(["--stop"], process.cwd(), {
            temporaryRoot: root,
            stderr: { write: (message) => messages.push(message) },
        });
        expect(code).toBe(1);
        expect(messages.join("")).toBe(`Resident host startup is already in progress (PID ${process.pid})\n`);
    } finally {
        await claim.release();
        rmSync(root, { recursive: true, force: true });
    }
});
