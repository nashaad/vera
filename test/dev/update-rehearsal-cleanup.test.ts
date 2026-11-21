import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT = fileURLToPath(new URL("../../scripts/update-rehearsal-client.sh", import.meta.url));

describe("update rehearsal cleanup", () => {
    test("@core validation failures do not claim uncreated paths were kept", () => {
        const root = mkdtempSync(join(tmpdir(), "vera-rehearsal-validation-"));
        const prefix = join(root, "prefix");
        const home = join(root, "home");
        try {
            mkdirSync(prefix);
            const result = spawnSync("sh", [CLIENT, "http://127.0.0.1:1", prefix, home, "1.0.0", "2.0.0"], {
                encoding: "utf8",
            });

            expect(result.status).toBe(1);
            expect(result.stdout).toContain("prefix and home must not exist");
            expect(result.stderr).not.toContain("Rehearsal paths kept:");
            expect(existsSync(prefix)).toBe(true);
            expect(existsSync(home)).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    for (const leg of ["cold", ""]) {
        test(`@core ${leg || "outer loop"} keeps its paths after an early failure`, () => {
            const root = mkdtempSync(join(tmpdir(), "vera-rehearsal-test-"));
            const prefix = join(root, "prefix");
            const home = join(root, "home");
            const bin = join(root, "bin");
            try {
                mkdirSync(bin);
                writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
                const result = spawnSync("sh", [CLIENT, "http://127.0.0.1:1", prefix, home, "1.0.0", "2.0.0"], {
                    encoding: "utf8",
                    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, VERA_REHEARSAL_LEG: leg },
                    timeout: 30000,
                });

                expect(result.status).not.toBe(0);
                expect(result.status).not.toBeNull();
                expect(existsSync(prefix)).toBe(true);
                expect(existsSync(home)).toBe(true);
                expect(result.stderr).toContain(`Rehearsal paths kept: ${prefix} ${home}`);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
    }
});
