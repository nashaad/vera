import { expect, test } from "bun:test";
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PINNED_BUILD_ENV } from "../../src/host/pinned-build.ts";
import { HostBuildMismatchError } from "../../src/host/lockfile.ts";
import {
    dispatchToHostRelease,
    RETAINED_DISPATCH_ENV,
    RetainedReleaseMissingError,
} from "../../src/release/dispatch.ts";
import { releaseDirectory } from "../../src/release/layout.ts";

function writeClient(prefix: string, buildId: string, body = "#!/bin/sh\nexit 0\n"): string {
    const root = releaseDirectory(buildId, prefix);
    mkdirSync(root, { recursive: true });
    const path = join(root, "vera");
    writeFileSync(path, body, { encoding: "utf8", mode: 0o755 });
    chmodSync(path, 0o755);
    return path;
}

test("a pinned rescue does not hop to the live host", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-dispatch-pin-"));
    try {
        writeClient(prefix, "vera-b");
        let execs = 0;
        const exit = await dispatchToHostRelease({
            prefix,
            clientBuildId: "vera-c",
            env: { [PINNED_BUILD_ENV]: "1" },
            inspectHost: async () => "vera-b",
            exec: async () => {
                execs += 1;
                return 0;
            },
        });
        expect(exit).toBeUndefined();
        expect(execs).toBe(0);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("a matching host leaves this process in place", async () => {
    let execs = 0;
    const exit = await dispatchToHostRelease({
        clientBuildId: "vera-same",
        inspectHost: async () => "vera-same",
        exec: async () => {
            execs += 1;
            return 0;
        },
    });
    expect(exit).toBeUndefined();
    expect(execs).toBe(0);
});

test("no live host leaves this process in place", async () => {
    let execs = 0;
    const exit = await dispatchToHostRelease({
        clientBuildId: "vera-c",
        inspectHost: async () => undefined,
        exec: async () => {
            execs += 1;
            return 0;
        },
    });
    expect(exit).toBeUndefined();
    expect(execs).toBe(0);
});

test("a live host B with retained client B execs that client", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-dispatch-b-"));
    try {
        const client = writeClient(prefix, "vera-b");
        const hops: string[] = [];
        const exit = await dispatchToHostRelease({
            prefix,
            clientBuildId: "vera-c",
            argv: ["host", "stop"],
            env: {},
            inspectHost: async () => "vera-b",
            exec: async (path, argv, env) => {
                hops.push(path);
                expect(argv).toEqual(["host", "stop"]);
                expect(env[RETAINED_DISPATCH_ENV]).toBe("1");
                expect(env).toEqual({ [RETAINED_DISPATCH_ENV]: "1" });
                return 7;
            },
        });
        expect(exit).toBe(7);
        expect(hops).toEqual([client]);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("a missing retained release refuses and does not attach", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-dispatch-missing-"));
    try {
        let execs = 0;
        try {
            await dispatchToHostRelease({
                prefix,
                clientBuildId: "vera-c",
                inspectHost: async () => "vera-b",
                exec: async () => {
                    execs += 1;
                    return 0;
                },
            });
            throw new Error("expected a missing retained release");
        } catch (error) {
            expect(error).toBeInstanceOf(RetainedReleaseMissingError);
            expect((error as RetainedReleaseMissingError).message).toContain("vera-c");
            expect((error as RetainedReleaseMissingError).message).toContain("vera-b");
            expect((error as RetainedReleaseMissingError).message).toContain("not retained");
            expect((error as RetainedReleaseMissingError).message).toContain("vera host stop");
            expect((error as RetainedReleaseMissingError).message).toContain("vera rollback");
        }
        expect(execs).toBe(0);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("resolution retries once when the host changes between inspections", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-dispatch-retry-"));
    try {
        writeClient(prefix, "vera-b");
        const clientC = writeClient(prefix, "vera-c");
        const seen: string[] = [];
        let inspects = 0;
        const exit = await dispatchToHostRelease({
            prefix,
            clientBuildId: "vera-a",
            inspectHost: async () => {
                inspects += 1;
                return inspects === 1 ? "vera-b" : "vera-c";
            },
            exec: async (path) => {
                seen.push(path);
                return 0;
            },
        });
        expect(exit).toBe(0);
        expect(seen).toEqual([clientC]);
        expect(inspects).toBe(3);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("an already dispatched client does not hop again", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-dispatch-guard-"));
    try {
        writeClient(prefix, "vera-d");
        let execs = 0;
        try {
            await dispatchToHostRelease({
                prefix,
                clientBuildId: "vera-b",
                env: { [RETAINED_DISPATCH_ENV]: "1" },
                inspectHost: async () => "vera-d",
                exec: async () => {
                    execs += 1;
                    return 0;
                },
            });
            throw new Error("expected a mismatch after one hop");
        } catch (error) {
            expect(error).toBeInstanceOf(HostBuildMismatchError);
            expect((error as HostBuildMismatchError).message).toContain("vera-b");
            expect((error as HostBuildMismatchError).message).toContain("vera-d");
        }
        expect(execs).toBe(0);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("a real retained wrapper is the process that runs", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-dispatch-exec-"));
    try {
        const marker = join(prefix, "ran");
        writeClient(
            prefix,
            "vera-b",
            `#!/bin/sh\nprintf 'ran-b %s\\n' "$*" > '${marker}'\n`,
        );
        const child = await dispatchToHostRelease({
            prefix,
            clientBuildId: "vera-c",
            argv: ["host", "stop"],
            inspectHost: async () => "vera-b",
        });
        expect(child).toBe(0);
        expect(await Bun.file(marker).text()).toBe("ran-b host stop\n");
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});
