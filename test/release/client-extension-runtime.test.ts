import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installRelease } from "../../scripts/pack-release.ts";
import { bundleRelease } from "../../src/release/bundle.ts";

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
        const source = readFileSync(join(sourceRoot, fixture), "utf8").replace(
            'resolve(import.meta.dir, "../../../extensions/diff")',
            'resolve(process.execPath, "../extensions/diff")',
        );
        writeFileSync(probe, source);
        const build = await Bun.build({
            entrypoints: [probe], root: installed.releaseRoot, outdir: join(installed.releaseRoot, "bundle"),
            target: "bun", splitting: true, minify: { identifiers: true, syntax: false, whitespace: false },
            external: ["@opentui/core", "@opentui/core/testing", "sharp", "trash", "unpdf"],
        });
        expect(build.success, build.logs.map(String).join("; ")).toBe(true);
        const bundledProbe = join(installed.releaseRoot, "bundle", "test", "release", "fixtures", "render-client-diff.js");
        // Plain Bun inside the release stands in for vera-bin, so execPath-relative lookups resolve there.
        copyFileSync(process.execPath, join(installed.releaseRoot, "bun"));
        chmodSync(join(installed.releaseRoot, "bun"), 0o755);
        for (const entry of [probe, bundledProbe]) for (const cwd of [sourceRoot, workspace]) {
            const child = Bun.spawn([join(installed.releaseRoot, "bun"), entry, workspace], {
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
        const dispatcher = join(installed.releaseRoot, "scripts", "release-role-entry.ts");
        mkdirSync(resolve(dispatcher, ".."), { recursive: true });
        const dispatcherSource = readFileSync(join(sourceRoot, "scripts", "release-role-entry.ts"), "utf8");
        writeFileSync(dispatcher, dispatcherSource.replace(
            "    default:",
            `    case "probe":\n        await import(${JSON.stringify(probe)});\n        break;\n    default:`,
        ));
        await bundleRelease(installed.releaseRoot, installed.releaseRoot, dispatcher);
        const compiled = Bun.spawn([join(installed.releaseRoot, "vera-bin"), "--vera-role=probe", workspace], {
            cwd: sourceRoot,
            env: { ...process.env, VERA_HOME: join(scratch, "home"), NODE_PATH: join(installed.releaseRoot, "node_modules") },
            stdout: "pipe", stderr: "pipe",
        });
        const timeout = setTimeout(() => compiled.kill(), 15_000);
        try {
            const [stdout, stderr, exit] = await Promise.all([
                new Response(compiled.stdout).text(), new Response(compiled.stderr).text(), compiled.exited,
            ]);
            expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
            expect(stdout).toContain("diff mounted and reloaded");
        } finally { clearTimeout(timeout); compiled.kill(); await compiled.exited; }
    } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 60_000);
