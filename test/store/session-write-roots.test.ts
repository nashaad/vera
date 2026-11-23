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

test("@core write roots persist in the session header and copy to a branch", async () => {
    const directory = temporaryDirectory();
    const first = join(directory, "root-one");
    const second = join(directory, "root-two");
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "rooted",
        cwd: "/work/vera",
        writeRoots: [first, second],
    });

    expect(store.header.writeRoots).toEqual([first, second]);
    const reopened = await SessionStore.open(path);
    expect(reopened.header.writeRoots).toEqual([first, second]);
    expect(
        JSON.parse(readFileSync(path, "utf8").split("\n")[0]!).writeRoots,
    ).toEqual([first, second]);

    const branch = await createSessionBranch({
        source: store,
        destinationPath: join(directory, "branch.jsonl"),
        sessionId: "branch",
        position: "at",
    });
    expect(branch.store.header.writeRoots).toEqual([first, second]);
});

test("a session without write roots keeps the header field absent", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "plain.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "plain",
        cwd: "/work/vera",
        writeRoots: [],
    });

    expect("writeRoots" in store.header).toBe(false);
    const header = JSON.parse(readFileSync(path, "utf8").split("\n")[0]!);
    expect("writeRoots" in header).toBe(false);
    expect((await SessionStore.open(path)).header.writeRoots).toBeUndefined();
});

test("@core the header parser refuses the filesystem root and non-canonical roots", async () => {
    const directory = temporaryDirectory();
    const valid = join(directory, "shared");
    const path = join(directory, "valid.jsonl");
    await SessionStore.create(path, {
        sessionId: "valid",
        cwd: "/work/vera",
        writeRoots: [valid],
    });
    const header = JSON.parse(readFileSync(path, "utf8").split("\n")[0]!);
    expect((await SessionStore.open(path)).header.writeRoots).toEqual([valid]);

    const refused: readonly unknown[] = [
        "/",
        ".",
        "relative/path",
        `${valid}/../shared`,
        `${valid}/`,
        "",
        42,
        [["/tmp"]],
        Array.from(
            { length: MAX_SESSION_ROOTS + 1 },
            (_, index) => join(directory, `root-${index}`),
        ),
    ];
    for (const [index, writeRoots] of refused.entries()) {
        const bad = join(directory, `bad-${index}.jsonl`);
        writeFileSync(
            bad,
            `${JSON.stringify({ ...header, writeRoots })}\n`,
            { mode: 0o600 },
        );
        await expect(SessionStore.open(bad)).rejects.toThrow();
    }
});

test("@core session creation refuses invalid write roots", async () => {
    const directory = temporaryDirectory();
    await expect(
        SessionStore.create(join(directory, "bad.jsonl"), {
            sessionId: "bad",
            cwd: "/work/vera",
            writeRoots: ["/"],
        }),
    ).rejects.toThrow("Cannot create a session with invalid write roots");
});

function temporaryDirectory(): string {
    const directory = realpathSync(
        mkdtempSync(join(tmpdir(), "vera-write-roots-")),
    );
    temporaryDirectories.push(directory);
    return directory;
}
