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

import { resolveSessionReadRoots } from "../../src/host/session-roots.ts";
import { MAX_SESSION_ROOTS } from "../../src/store/session-roots.ts";

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

test("@core read roots resolve to canonical directories and dedupe", async () => {
    const directory = temporaryDirectory();
    const root = join(directory, "root");
    mkdirSync(root);
    mkdirSync(join(root, "nested"));
    const link = join(directory, "link");
    symlinkSync(root, link);

    expect(
        await resolveSessionReadRoots([
            root,
            link,
            join(root, "nested", ".."),
            `${root}/`,
        ]),
    ).toEqual([root]);
    expect(await resolveSessionReadRoots([])).toBeUndefined();
    expect(await resolveSessionReadRoots(undefined)).toBeUndefined();
});

test("@core read roots refuse empty, relative, missing and non-directory paths", async () => {
    const directory = temporaryDirectory();
    const file = join(directory, "file.txt");
    writeFileSync(file, "x");

    await expect(resolveSessionReadRoots([" "])).rejects.toThrow(
        "Read root must not be empty.",
    );
    await expect(resolveSessionReadRoots(["relative/path"])).rejects.toThrow(
        "Read root relative/path must be an absolute path.",
    );
    await expect(
        resolveSessionReadRoots([join(directory, "missing")]),
    ).rejects.toThrow(
        `Read root ${join(directory, "missing")} does not exist.`,
    );
    await expect(resolveSessionReadRoots([file])).rejects.toThrow(
        `Read root ${file} is not a directory.`,
    );
});

test("@core read roots refuse the filesystem root and paths over Vera's home", async () => {
    const directory = temporaryDirectory();
    const home = homedir();
    if (!existsSync(home)) {
        mkdirSync(home, { recursive: true });
        createdTestHome = true;
    }
    const veraHome = realpathSync(process.env.VERA_HOME!);
    const insideVeraHome = join(veraHome, "roots", "one");
    mkdirSync(insideVeraHome, { recursive: true });

    await expect(resolveSessionReadRoots(["/"])).rejects.toThrow(
        "Read root / is the filesystem root.",
    );
    await expect(resolveSessionReadRoots([homedir()])).rejects.toThrow(
        `Read root ${home} is the home directory.`,
    );
    await expect(resolveSessionReadRoots([dirname(home)])).rejects.toThrow(
        `Read root ${dirname(home)} contains the home directory.`,
    );
    await expect(resolveSessionReadRoots([insideVeraHome])).rejects.toThrow(
        `Read root ${insideVeraHome} overlaps Vera's home.`,
    );
    await expect(resolveSessionReadRoots([dirname(veraHome)])).rejects.toThrow(
        `Read root ${dirname(veraHome)} overlaps Vera's home.`,
    );
    await expect(resolveSessionReadRoots([directory])).resolves.toEqual([
        directory,
    ]);
});

test("@core a session has at most sixteen read roots", async () => {
    const directory = temporaryDirectory();
    const roots = Array.from(
        { length: MAX_SESSION_ROOTS + 1 },
        (_, index) => {
            const root = join(directory, `root-${index}`);
            mkdirSync(root);
            return root;
        },
    );

    await expect(resolveSessionReadRoots(roots)).rejects.toThrow(
        `A session can have at most ${MAX_SESSION_ROOTS} read roots.`,
    );
    await expect(resolveSessionReadRoots(roots.slice(0, -1))).resolves.toHaveLength(
        MAX_SESSION_ROOTS,
    );
});

function temporaryDirectory(): string {
    const directory = realpathSync(
        mkdtempSync(join(tmpdir(), "vera-host-read-roots-")),
    );
    temporaryDirectories.push(directory);
    return directory;
}
