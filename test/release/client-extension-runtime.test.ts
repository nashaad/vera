import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installRelease } from "../../scripts/pack-release.ts";

const sourceRoot = resolve(import.meta.dir, "../..");

test("installed client extensions share the renderer runtime across workspaces and reloads", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "vera-extension-runtime-"));
    try {
        const installed = await installRelease({ prefix: join(scratch, "install"), cwd: sourceRoot, sourceRoot });
        const workspace = join(scratch, "workspace");
        mkdirSync(workspace);
        execFileSync("git", ["init", "-q", workspace]);
        writeFileSync(join(workspace, "file.txt"), "hello from workspace\n");
        const fixture = "test/release/fixtures/render-client-diff.ts";
        const probe = join(installed.releaseRoot, fixture);
        mkdirSync(resolve(probe, ".."), { recursive: true });
        cpSync(join(sourceRoot, fixture), probe);
        for (const cwd of [sourceRoot, workspace]) {
            const child = Bun.spawn([join(installed.releaseRoot, "bun"), probe, workspace], {
                cwd, env: { ...process.env, VERA_HOME: join(scratch, "home") },
                stdout: "pipe", stderr: "pipe",
            });
            const timeout = setTimeout(() => child.kill(), 15_000);
            try {
                const [stdout, stderr, exit] = await Promise.all([
                    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
                ]);
                expect({ cwd, exit, stderr }).toEqual({ cwd, exit: 0, stderr: "" });
                expect(stdout).toContain("diff mounted and reloaded");
            } finally { clearTimeout(timeout); child.kill(); await child.exited; }
        }
    } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 60_000);
