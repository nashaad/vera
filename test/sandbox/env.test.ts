import { afterAll, expect, test } from "bun:test";

import { mergeSandboxEnvironment } from "../../src/sandbox/env.ts";

const marker = "VERA_SANDBOX_ENV_MARKER";
const original = process.env[marker];

afterAll(() => {
    if (original === undefined) {
        delete process.env[marker];
    } else {
        process.env[marker] = original;
    }
});

// srt answers with this process's whole environment on macOS and Linux. A
// wrap in the shape of that answer, plus the proxy variable srt adds.
function fakeWrapperEnvironment(): Record<string, string> {
    process.env[marker] = "leak";
    return {
        ...(process.env as Record<string, string>),
        HTTP_PROXY: "http://127.0.0.1:9",
    };
}

test("@core sandbox env is the caller's list plus what the wrapper changed", () => {
    const caller = {
        VERA_WORKSPACE: "/work/repo",
        VERA_SKILL_DIR: "/skills/one",
        HOME: "/Users/me",
        PATH: "/usr/bin:/bin",
    };
    const merged = mergeSandboxEnvironment(caller, fakeWrapperEnvironment());
    expect(merged.VERA_WORKSPACE).toBe("/work/repo");
    expect(merged.VERA_SKILL_DIR).toBe("/skills/one");
    expect(merged.HTTP_PROXY).toBe("http://127.0.0.1:9");
});

test("@core sandbox env keeps nothing else this process holds", () => {
    const merged = mergeSandboxEnvironment(
        { VERA_WORKSPACE: "/work/repo" },
        fakeWrapperEnvironment(),
    );
    expect(merged[marker]).toBeUndefined();
    expect(merged.HOME).toBeUndefined();
    expect(merged.PATH).toBeUndefined();
    expect(Object.keys(merged).sort()).toEqual(["HTTP_PROXY", "VERA_WORKSPACE"]);
});

test("@core sandbox env lets a value the wrapper changed win over the caller's", () => {
    const merged = mergeSandboxEnvironment(
        { TMPDIR: "/caller/tmp", VERA_WORKSPACE: "/work/repo" },
        { ...(process.env as Record<string, string>), TMPDIR: "/wrapper/tmp" },
    );
    expect(merged.TMPDIR).toBe("/wrapper/tmp");
    expect(merged.VERA_WORKSPACE).toBe("/work/repo");
});

test("@core sandbox env ignores a caller entry with no value", () => {
    const merged = mergeSandboxEnvironment(
        { VERA_WORKSPACE: "/work/repo", VERA_SANDBOX_UNSET: undefined },
        fakeWrapperEnvironment(),
    );
    expect(merged.VERA_SANDBOX_UNSET).toBeUndefined();
    expect(Object.keys(merged).sort()).toEqual([
        "HTTP_PROXY",
        "VERA_WORKSPACE",
    ]);
});
