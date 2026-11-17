import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../../dev/hooks/pre-push", import.meta.url));
const SHA = "a".repeat(40);
const ZERO = "0".repeat(40);
const BRANCH = `refs/heads/main ${SHA} refs/heads/main ${ZERO}\n`;
const DELETION = `(delete) ${ZERO} refs/heads/old ${SHA}\n`;
const REMINDER = "pre-push: the full suite is bun test; this hook does not run it.\n";

function runHook(input: string): ReturnType<typeof spawnSync> {
    return spawnSync(HOOK, [], {
        encoding: "utf8",
        env: { ...process.env, PATH: "" },
        input,
    });
}

describe("pre-push hook", () => {
    test("@core a branch push prints a reminder and succeeds without bun", () => {
        const result = runHook(BRANCH);

        expect(result.status).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(REMINDER);
    });

    test("@core deletion-only refs are silent", () => {
        const zero256 = "0".repeat(64);
        const deletion256 = `(delete) ${zero256} refs/heads/other ${"b".repeat(64)}\n`;
        const result = runHook(DELETION + deletion256);

        expect(result.status).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("");
    });

    test("@core empty refs are silent", () => {
        const result = runHook("");

        expect(result.status).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("");
    });

    test("@core mixed refs print one reminder", () => {
        const result = runHook(DELETION + BRANCH + DELETION);

        expect(result.status).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(REMINDER);
    });

    test("@core the last ref does not need a trailing newline", () => {
        const result = runHook(BRANCH.trimEnd());

        expect(result.status).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(REMINDER);
    });

    test("@core a closed reminder pipe does not fail the push", async () => {
        const child = spawn(HOOK, [], {
            env: { ...process.env, PATH: "" },
            stdio: ["pipe", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr.destroy();
        child.stdin.end(BRANCH);
        const status = await new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code) => resolve(code));
        });

        expect(status).toBe(0);
        expect(Buffer.concat(stdout).toString("utf8")).toBe("");
    });

    test("@core closed stderr with errexit does not fail the push", () => {
        const result = spawnSync("/bin/sh", [
            "-c",
            'exec 2>&-; exec "$1"',
            "sh",
            HOOK,
        ], {
            encoding: "utf8",
            env: { ...process.env, PATH: "", SHELLOPTS: "errexit" },
            input: BRANCH,
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toBe("");
    });
});
