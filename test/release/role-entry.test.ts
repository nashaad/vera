import { expect, test } from "bun:test";
import { join, resolve } from "node:path";

const entry = resolve(import.meta.dir, "../../scripts/release-role-entry.ts");

function runRole(...args: string[]) {
    return Bun.spawnSync([process.execPath, entry, ...args], {
        env: {
            ...process.env,
            VERA_DEV_INSTANCE: "onebin dev",
            VERA_HOME: join(process.env.VERA_TEST_TEMP_BASE ?? "/tmp/vera-dev", "onebin-role-test"),
        },
        stdout: "pipe",
        stderr: "pipe",
    });
}

test("the dispatcher runs the CLI entrypoint", () => {
    const result = runRole("--vera-role=cli", "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Usage:");
});

test("the dispatcher runs the import child", () => {
    const result = runRole("--vera-role=import");
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("usage: session-import-child <path>");
});

test("the dispatcher rejects an unknown role", () => {
    const result = runRole("--vera-role=unknown");
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("Unknown Vera role: unknown");
});
