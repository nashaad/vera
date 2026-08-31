import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { installRelease } from "../../scripts/pack-release.ts";
import {
    RELEASE_ANNEX_NAME,
    RELEASE_CLI_NAME,
    launcherPath,
} from "../../src/release/layout.ts";
import { formatVeraVersion, readStampedRelease } from "../../src/release/stamp.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");
const mainCheckout = resolve(repoRoot, "..", "..");

function whichVera(pathEnv: string): string {
    const ran = Bun.spawnSync(["sh", "-c", "command -v vera"], {
        env: { PATH: pathEnv },
        stdout: "pipe",
        stderr: "pipe",
    });
    return ran.stdout.toString().trim();
}

function sandboxProfile(denied: readonly string[]): string {
    const denies = denied.flatMap((path) => [
        `(deny file-read* (subpath "${path}"))`,
        `(deny file-write* (subpath "${path}"))`,
    ]);
    return `(version 1)\n(allow default)\n${denies.join("\n")}\n`;
}

function runSandboxed(
    argv: readonly string[],
    options: {
        readonly profile: string;
        readonly cwd: string;
        readonly env: Record<string, string>;
        readonly detached?: boolean;
    },
): ReturnType<typeof Bun.spawnSync> | ReturnType<typeof Bun.spawn> {
    const profilePath = join(options.cwd, "vera-survive.sb");
    writeFileSync(profilePath, options.profile);
    const argvList = ["sandbox-exec", "-f", profilePath, ...argv];
    if (options.detached === true) {
        return Bun.spawn(argvList, {
            cwd: options.cwd,
            env: options.env,
            stdout: "pipe",
            stderr: "pipe",
        });
    }
    return Bun.spawnSync(argvList, {
        cwd: options.cwd,
        env: options.env,
        stdout: "pipe",
        stderr: "pipe",
    });
}

test("command -v vera is the launcher, and the release runs with the repo denied", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-survive-"));
    const userHome = mkdtempSync(join(tmpdir(), "vera-survive-home-"));
    const veraHome = mkdtempSync(join(tmpdir(), "vera-survive-verahome-"));
    const scratch = mkdtempSync(join(tmpdir(), "vera-survive-scratch-"));
    try {
        const installed = await installRelease({
            prefix,
            cwd: repoRoot,
            sourceRoot: repoRoot,
        });
        const pathEnv = [join(prefix, "bin"), "/usr/bin", "/bin"].join(":");
        const resolved = whichVera(pathEnv);
        expect(resolved).toBe(launcherPath(prefix));
        expect(resolved).not.toContain(repoRoot);
        expect(resolved).not.toMatch(/clients\/cli/);

        const launcher = readFileSync(installed.launcher, "utf8");
        expect(launcher).toContain(
            join(prefix, "share", "vera", "current", RELEASE_CLI_NAME),
        );
        expect(launcher).not.toContain(repoRoot);

        const wrapper = readFileSync(
            join(installed.releaseRoot, RELEASE_CLI_NAME),
            "utf8",
        );
        expect(wrapper).toContain("$here/clients/cli/main.ts");
        expect(wrapper).not.toContain(repoRoot);

        const expected = `${formatVeraVersion(readStampedRelease(installed.releaseRoot))}\n`;
        const childEnv = {
            HOME: userHome,
            PATH: pathEnv,
            VERA_HOME: veraHome,
        };
        const profile = sandboxProfile([repoRoot, mainCheckout]);
        const blockedRepo = runSandboxed(["/bin/cat", join(repoRoot, "package.json")], {
            profile,
            cwd: scratch,
            env: childEnv,
        }) as ReturnType<typeof Bun.spawnSync>;
        expect(blockedRepo.exitCode).not.toBe(0);
        const blockedModules = runSandboxed(
            ["/bin/cat", join(repoRoot, "node_modules", "react", "package.json")],
            {
                profile,
                cwd: scratch,
                env: childEnv,
            },
        ) as ReturnType<typeof Bun.spawnSync>;
        expect(blockedModules.exitCode).not.toBe(0);
        const version = runSandboxed(["vera", "--version"], {
            profile,
            cwd: scratch,
            env: childEnv,
        }) as ReturnType<typeof Bun.spawnSync>;
        expect(version.stderr.toString()).toBe("");
        expect(version.exitCode).toBe(0);
        expect(version.stdout.toString()).toBe(expected);

        const annex = runSandboxed(
            [
                join(installed.releaseRoot, RELEASE_ANNEX_NAME),
                "--home",
                veraHome,
                "--port",
                "0",
            ],
            {
                profile,
                cwd: scratch,
                env: childEnv,
                detached: true,
            },
        ) as ReturnType<typeof Bun.spawn>;
        const stdout = annex.stdout;
        const stderr = annex.stderr;
        const decoder = new TextDecoder();
        let outBuf = "";
        let errBuf = "";
        const readSide = async (
            stream: ReadableStream<Uint8Array>,
            into: "out" | "err",
        ): Promise<void> => {
            const reader = stream.getReader();
            for (;;) {
                const { value, done } = await reader.read();
                if (done) return;
                const text = decoder.decode(value, { stream: true });
                if (into === "out") outBuf += text;
                else errBuf += text;
            }
        };
        const reading = Promise.all([
            readSide(stdout, "out"),
            readSide(stderr, "err"),
        ]);
        const deadline = Date.now() + 10_000;
        let url: string | undefined;
        try {
            while (url === undefined && Date.now() < deadline) {
                const line = outBuf.split("\n")[0]?.trim();
                if (line !== undefined && line.startsWith("http://127.0.0.1:")) {
                    url = line.endsWith("/") ? line : `${line}/`;
                    break;
                }
                await Bun.sleep(50);
            }
            if (url === undefined) {
                annex.kill("SIGTERM");
                await annex.exited;
                throw new Error(
                    `annex did not listen\nstdout:\n${outBuf}\nstderr:\n${errBuf}\nexit: ${annex.exitCode}`,
                );
            }
            const page = await fetch(new URL("usage", url).href);
            expect(page.status).toBe(200);
            expect(await page.text()).toContain("Vera · Usage");
        } finally {
            annex.kill("SIGTERM");
            await annex.exited;
            await reading.catch(() => undefined);
        }
    } finally {
        rmSync(prefix, { recursive: true, force: true });
        rmSync(userHome, { recursive: true, force: true });
        rmSync(veraHome, { recursive: true, force: true });
        rmSync(scratch, { recursive: true, force: true });
    }
}, 120_000);
