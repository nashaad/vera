import { afterAll, expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { resolveSessionWriteRoots } from "../../src/host/write-roots.ts";
import { MAX_SESSION_WRITE_ROOTS } from "../../src/store/session-write-roots.ts";

const temporaryDirectories: string[] = [];
let createdTestHome = false;

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
    if (createdTestHome) {
        rmSync(homedir(), { recursive: true, force: true });
    }
});

test("@core write roots resolve to canonical directories and dedupe", async () => {
    const directory = temporaryDirectory();
    const root = join(directory, "root");
    mkdirSync(root);
    mkdirSync(join(root, "nested"));
    const link = join(directory, "link");
    symlinkSync(root, link);

    expect(
        await resolveSessionWriteRoots([
            root,
            link,
            join(root, "nested", ".."),
            `${root}/`,
        ]),
    ).toEqual([root]);
    expect(await resolveSessionWriteRoots([])).toBeUndefined();
    expect(await resolveSessionWriteRoots(undefined)).toBeUndefined();
});

test("@core write roots refuse empty, relative, missing and non-directory paths", async () => {
    const directory = temporaryDirectory();
    const file = join(directory, "file.txt");
    writeFileSync(file, "x");

    await expect(resolveSessionWriteRoots([" "])).rejects.toThrow(
        "Write root must not be empty.",
    );
    await expect(resolveSessionWriteRoots(["relative/path"])).rejects.toThrow(
        "Write root relative/path must be an absolute path.",
    );
    await expect(
        resolveSessionWriteRoots([join(directory, "missing")]),
    ).rejects.toThrow(
        `Write root ${join(directory, "missing")} does not exist.`,
    );
    await expect(resolveSessionWriteRoots([file])).rejects.toThrow(
        `Write root ${file} is not a directory.`,
    );
});

test("@core write roots refuse the filesystem root and paths over Vera's home", async () => {
    const directory = temporaryDirectory();
    const home = homedir();
    if (!existsSync(home)) {
        mkdirSync(home, { recursive: true });
        createdTestHome = true;
    }
    const veraHome = realpathSync(process.env.VERA_HOME!);
    const insideVeraHome = join(veraHome, "roots", "one");
    mkdirSync(insideVeraHome, { recursive: true });

    await expect(resolveSessionWriteRoots(["/"])).rejects.toThrow(
        "Write root / is the filesystem root.",
    );
    await expect(resolveSessionWriteRoots([homedir()])).rejects.toThrow(
        `Write root ${home} is the home directory.`,
    );
    await expect(resolveSessionWriteRoots([dirname(home)])).rejects.toThrow(
        `Write root ${dirname(home)} contains the home directory.`,
    );
    await expect(resolveSessionWriteRoots([insideVeraHome])).rejects.toThrow(
        `Write root ${insideVeraHome} overlaps Vera's home.`,
    );
    await expect(resolveSessionWriteRoots([dirname(veraHome)])).rejects.toThrow(
        `Write root ${dirname(veraHome)} overlaps Vera's home.`,
    );
    await expect(resolveSessionWriteRoots([directory])).resolves.toEqual([
        directory,
    ]);
});

test("@core a session has at most sixteen write roots", async () => {
    const directory = temporaryDirectory();
    const roots = Array.from(
        { length: MAX_SESSION_WRITE_ROOTS + 1 },
        (_, index) => {
            const root = join(directory, `root-${index}`);
            mkdirSync(root);
            return root;
        },
    );

    await expect(resolveSessionWriteRoots(roots)).rejects.toThrow(
        `A session can have at most ${MAX_SESSION_WRITE_ROOTS} write roots.`,
    );
    await expect(resolveSessionWriteRoots(roots.slice(0, -1))).resolves.toHaveLength(
        MAX_SESSION_WRITE_ROOTS,
    );
});

function temporaryDirectory(): string {
    const directory = realpathSync(
        mkdtempSync(join(tmpdir(), "vera-host-write-roots-")),
    );
    temporaryDirectories.push(directory);
    return directory;
}
