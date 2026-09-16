import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { installRelease } from "../../scripts/pack-release.ts";

const root = resolve(import.meta.dir, "../..");

test("an installed release activates included batteries without checkout examples", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "vera-batteries-release-"));
    try {
        const installed = await installRelease({
            prefix: join(scratch, "prefix"), cwd: root, sourceRoot: root,
        });
        expect(existsSync(join(installed.releaseRoot, "examples"))).toBe(false);
        const script = join(installed.releaseRoot, "check-batteries.ts");
        writeFileSync(script, `
            import { defaultHostExtensionConfigs } from "./src/extensions/bundled-host.ts";
            import { bundledClientExtensionConfigs } from "./src/extensions/bundled-client.ts";
            import { startExtensionRegistry } from "./src/extensions/registry.ts";
            import { startClientExtensionRegistry } from "./src/extensions/client-registry.ts";
            const failures = [];
            const host = await startExtensionRegistry({
                extensions: defaultHostExtensionConfigs([]),
                onFailure: (failure) => failures.push(failure.message),
            });
            const client = await startClientExtensionRegistry({
                extensions: bundledClientExtensionConfigs([]),
                preferences: { async get() {}, async set() {}, async delete() {} },
                modelSettings: {
                    current: () => undefined,
                    async update() { return { status: "rejected", reason: "unavailable" }; },
                    subscribe: () => () => {},
                },
                picker: { async request() { return { outcome: "cancelled" }; } },
                notice: { post() {} },
                agents: {
                    visible: () => [],
                    async create() { throw new Error("Unexpected creation"); },
                    async open() { throw new Error("Unexpected open"); },
                    async message() { throw new Error("Unexpected message"); },
                },
                mentions: { set() {} },
                onFailure: (failure) => failures.push(failure.message),
            });
            try {
                console.log(JSON.stringify({
                    failures,
                    plan: host.agents().find((entry) => entry.name === "plan"),
                    preHooks: host.preToolUseHooks().length,
                    postHooks: host.postToolUseHooks().length,
                    commands: client.commands().map((entry) => entry.name),
                    suggestions: client.composeSuggesters().length,
                }));
            } finally {
                await client.close();
                await host.close();
            }
        `);
        const child = Bun.spawn([process.execPath, script], {
            cwd: installed.releaseRoot,
            env: { ...process.env, VERA_HOME: join(scratch, "home") },
            stdout: "pipe", stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect(stderr).toBe("");
        expect(code).toBe(0);
        const result = JSON.parse(stdout);
        expect(result.failures).toEqual([]);
        expect(result.plan.tools).toEqual(["read", "grep", "list"]);
        expect(result.preHooks).toBe(0);
        expect(result.postHooks).toBe(0);
        expect(result.commands).toContain("btw");
        expect(result.commands).toContain("pair");
        expect(result.suggestions).toBe(0);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}, 60_000);
