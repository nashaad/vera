import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInstanceDirectory } from "../../src/instances/directory.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("instance directory atomically creates a JSON presence record", () => {
    const path = temporaryInstancePath();
    const directory = createInstanceDirectory({
        path,
        pid: 101,
        now: () => new Date("2026-07-15T14:00:00.000Z"),
        createInstanceId: () => "instance-a",
        isProcessAlive: () => true,
    });

    const registration = directory.register({
        client: "stdio",
        workspacePath: "/work/alpha",
    });

    expect(readdirSync(path)).toEqual(["101.json"]);
    expect(JSON.parse(readFileSync(join(path, "101.json"), "utf8")))
        .toEqual(registration.record);
});

test("two live instances are listed deterministically and remove only themselves", () => {
    const path = temporaryInstancePath();
    const livePids = new Set([101, 202]);
    const first = createInstanceDirectory({
        path,
        pid: 101,
        now: () => new Date("2026-07-15T14:02:00.000Z"),
        createInstanceId: () => "instance-b",
        isProcessAlive: (pid) => livePids.has(pid),
    }).register({
        client: "stdio",
        workspacePath: "/work/beta",
    });
    const secondDirectory = createInstanceDirectory({
        path,
        pid: 202,
        now: () => new Date("2026-07-15T14:01:00.000Z"),
        createInstanceId: () => "instance-a",
        isProcessAlive: (pid) => livePids.has(pid),
    });
    const second = secondDirectory.register({
        client: "tui",
        workspacePath: "/work/alpha",
    });

    expect(secondDirectory.list()).toEqual([second.record, first.record]);

    first.remove();

    expect(secondDirectory.list()).toEqual([second.record]);
    expect(readdirSync(path)).toEqual(["202.json"]);
});

test("cleanup does not remove a replacement record for the same pid", () => {
    const path = temporaryInstancePath();
    const original = createInstanceDirectory({
        path,
        pid: 101,
        createInstanceId: () => "original",
    }).register({
        client: "stdio",
        workspacePath: "/work/alpha",
    });
    const replacementDirectory = createInstanceDirectory({
        path,
        pid: 101,
        createInstanceId: () => "replacement",
        isProcessAlive: () => true,
    });
    const replacement = replacementDirectory.register({
        client: "tui",
        workspacePath: "/work/alpha",
    });

    original.remove();

    expect(replacementDirectory.list()).toEqual([replacement.record]);
});

test("listing reaps a record whose process is no longer alive", () => {
    const path = temporaryInstancePath();
    createInstanceDirectory({
        path,
        pid: 101,
        createInstanceId: () => "stale-instance",
    }).register({
        client: "stdio",
        workspacePath: "/work/alpha",
    });
    const directory = createInstanceDirectory({
        path,
        isProcessAlive: () => false,
    });

    expect(directory.list()).toEqual([]);
    expect(readdirSync(path)).toEqual([]);
});

function temporaryInstancePath(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-instances-"));
    temporaryDirectories.push(root);
    return join(root, "instances");
}
