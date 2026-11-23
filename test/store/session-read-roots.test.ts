import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_SESSION_ROOTS } from "../../src/store/session-roots.ts";
import { createSessionBranch } from "../../src/store/session-branch.ts";
import { SessionStore } from "../../src/store/session-store.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("@core read roots persist in the session header, survive a reopen and copy to a branch", async () => {
    const directory = temporaryDirectory();
    const first = join(directory, "reference-one");
    const second = join(directory, "reference-two");
    const written = join(directory, "writable");
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "rooted",
        cwd: "/work/vera",
        writeRoots: [written],
        readRoots: [first, second],
    });

    expect(store.header.readRoots).toEqual([first, second]);
    const reopened = await SessionStore.open(path);
    expect(reopened.header.readRoots).toEqual([first, second]);
    expect(reopened.header.writeRoots).toEqual([written]);
    const stored = JSON.parse(readFileSync(path, "utf8").split("\n")[0]!);
    expect(stored.readRoots).toEqual([first, second]);
    expect(stored.writeRoots).toEqual([written]);

    const branch = await createSessionBranch({
        source: reopened,
        destinationPath: join(directory, "branch.jsonl"),
        sessionId: "branch",
        position: "at",
    });
    expect(branch.store.header.readRoots).toEqual([first, second]);
    expect(branch.store.header.writeRoots).toEqual([written]);
    const reopenedBranch = await SessionStore.open(join(directory, "branch.jsonl"));
    expect(reopenedBranch.header.readRoots).toEqual([first, second]);
});

test("a session without read roots keeps the header field absent", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "plain.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "plain",
        cwd: "/work/vera",
        readRoots: [],
    });

    expect("readRoots" in store.header).toBe(false);
    const header = JSON.parse(readFileSync(path, "utf8").split("\n")[0]!);
    expect("readRoots" in header).toBe(false);
    expect((await SessionStore.open(path)).header.readRoots).toBeUndefined();

    const branch = await createSessionBranch({
        source: store,
        destinationPath: join(directory, "branch.jsonl"),
        sessionId: "branch",
        position: "at",
    });
    expect("readRoots" in branch.store.header).toBe(false);
});

test("@core the header parser refuses the filesystem root and non-canonical read roots", async () => {
    const directory = temporaryDirectory();
    const valid = join(directory, "reference");
    const path = join(directory, "valid.jsonl");
    await SessionStore.create(path, {
        sessionId: "valid",
        cwd: "/work/vera",
        readRoots: [valid],
    });
    const header = JSON.parse(readFileSync(path, "utf8").split("\n")[0]!);
    expect((await SessionStore.open(path)).header.readRoots).toEqual([valid]);

    const refused: readonly unknown[] = [
        "/",
        ".",
        "relative/path",
        `${valid}/../reference`,
        `${valid}/`,
        "",
        42,
        [["/tmp"]],
        Array.from(
            { length: MAX_SESSION_ROOTS + 1 },
            (_, index) => join(directory, `root-${index}`),
        ),
    ];
    for (const [index, readRoots] of refused.entries()) {
        const bad = join(directory, `bad-${index}.jsonl`);
        writeFileSync(
            bad,
            `${JSON.stringify({ ...header, readRoots })}\n`,
            { mode: 0o600 },
        );
        await expect(SessionStore.open(bad)).rejects.toThrow();
    }
});

test("@core session creation refuses invalid read roots", async () => {
    const directory = temporaryDirectory();
    await expect(
        SessionStore.create(join(directory, "bad.jsonl"), {
            sessionId: "bad",
            cwd: "/work/vera",
            readRoots: ["/"],
        }),
    ).rejects.toThrow("Cannot create a session with invalid read roots");
});

function temporaryDirectory(): string {
    const directory = realpathSync(
        mkdtempSync(join(tmpdir(), "vera-read-roots-")),
    );
    temporaryDirectories.push(directory);
    return directory;
}
