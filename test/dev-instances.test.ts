import { afterAll, expect, test } from "bun:test";
import {
    existsSync,
    mkdtempSync,
    mkdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
    devInstanceDirectory,
    devInstancePath,
    dropDevInstance,
    listDevInstances,
    processIsDevelopmentInstance,
    registerDevInstance,
    runningTreeRoot,
} from "../src/dev-instances.ts";
import {
    defaultInstallPrefix,
    releaseDirectory,
    releasesDirectory,
} from "../src/release/layout.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function tempDir(prefix: string): string {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

function tempHome(): string {
    const home = join(tempDir("vera-dev-instance-"), ".vera");
    mkdirSync(home, { recursive: true });
    return home;
}

test("the registry sits outside every Vera home", () => {
    const root = tempDir("vera-dev-root-");
    const directory = devInstanceDirectory(root);
    expect(directory).toBe(join(root, ".vera-dev", "instances"));
    expect(directory.split(sep)).not.toContain(".vera");
});

function treeAt(root: string): string {
    mkdirSync(join(root, "clients", "host"), { recursive: true });
    writeFileSync(join(root, "clients", "host", "main.ts"), "");
    return root;
}

function onTrialHome(treeRoot: string): {
    readonly treeRoot: string;
    readonly home: string;
    readonly userHome: string;
} {
    const userHome = tempDir("vera-user-");
    return { treeRoot, home: join(tempDir("vera-trial-"), "home"), userHome };
}

test("a checkout with a .git directory is development", () => {
    const root = treeAt(join(tempDir("vera-checkout-"), "vera"));
    mkdirSync(join(root, ".git"));

    expect(processIsDevelopmentInstance(onTrialHome(root))).toBe(true);
});

test("a linked worktree, whose .git is a file, is development", () => {
    const root = treeAt(
        join(tempDir("vera-checkout-"), "vera", ".worktrees", "devreg"),
    );
    writeFileSync(join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/devreg\n");

    expect(processIsDevelopmentInstance(onTrialHome(root))).toBe(true);
});

test("a checkout reached through a symlink is development", () => {
    const parent = tempDir("vera-checkout-");
    const root = treeAt(join(parent, "vera"));
    mkdirSync(join(root, ".git"));
    const link = join(parent, "linked");
    symlinkSync(root, link);

    expect(processIsDevelopmentInstance(onTrialHome(link))).toBe(true);
});

test("the npm package is not development, with or without a releases directory", () => {
    const home = tempDir("vera-home-");
    const packageRoot = treeAt(
        join(home, "lib", "node_modules", "@nashaad", "vera"),
    );
    writeFileSync(join(packageRoot, "package.json"), "{}\n");

    expect(processIsDevelopmentInstance(onTrialHome(packageRoot))).toBe(false);

    mkdirSync(releasesDirectory(defaultInstallPrefix(home)), { recursive: true });
    expect(processIsDevelopmentInstance(onTrialHome(packageRoot))).toBe(false);
});

test("the install:local release tree is not development", () => {
    const home = tempDir("vera-home-");
    const release = treeAt(
        releaseDirectory("vera-abc123", defaultInstallPrefix(home)),
    );
    writeFileSync(join(release, "manifest.json"), "{}\n");

    expect(processIsDevelopmentInstance(onTrialHome(release))).toBe(false);
});

test("a package installed inside a git project does not inherit the project's .git", () => {
    const project = tempDir("vera-project-");
    mkdirSync(join(project, ".git"));
    const packageRoot = treeAt(
        join(project, "node_modules", "@nashaad", "vera"),
    );

    expect(processIsDevelopmentInstance(onTrialHome(packageRoot))).toBe(false);
});

test("a tree that cannot be resolved is not development", () => {
    const missing = join(tempDir("vera-gone-"), "vera");

    expect(processIsDevelopmentInstance(onTrialHome(missing))).toBe(false);
});

function checkoutTree(): string {
    const root = treeAt(join(tempDir("vera-checkout-"), "vera"));
    mkdirSync(join(root, ".git"));
    return root;
}

test("a checkout on the default home is not development", () => {
    const treeRoot = checkoutTree();
    const userHome = tempDir("vera-user-");
    const home = join(userHome, ".vera");
    mkdirSync(home);

    expect(processIsDevelopmentInstance({ treeRoot, home, userHome })).toBe(false);
});

test("a symlink to the default home is still the default home", () => {
    const treeRoot = checkoutTree();
    const userHome = tempDir("vera-user-");
    mkdirSync(join(userHome, ".vera"));
    const alias = join(tempDir("vera-alias-"), "home");
    symlinkSync(join(userHome, ".vera"), alias);

    expect(
        processIsDevelopmentInstance({ treeRoot, home: alias, userHome }),
    ).toBe(false);
});

test("a checkout on a home of its own is development", () => {
    const treeRoot = checkoutTree();
    const userHome = tempDir("vera-user-");
    mkdirSync(join(userHome, ".vera"));
    const home = join(tempDir("vera-trial-"), "home");
    mkdirSync(home);

    expect(processIsDevelopmentInstance({ treeRoot, home, userHome })).toBe(true);
});

test("the home defaults to the one VERA_HOME names", () => {
    const treeRoot = checkoutTree();
    const userHome = tempDir("vera-user-");
    mkdirSync(join(userHome, ".vera"));
    const previous = process.env.VERA_HOME;
    try {
        process.env.VERA_HOME = join(userHome, ".vera");
        expect(processIsDevelopmentInstance({ treeRoot, userHome })).toBe(false);

        process.env.VERA_HOME = join(tempDir("vera-trial-"), "home");
        expect(processIsDevelopmentInstance({ treeRoot, userHome })).toBe(true);
    } finally {
        if (previous === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previous;
    }
});

test("the running tree is the one that holds this module", () => {
    const root = runningTreeRoot();

    expect(existsSync(join(root, "src", "dev-instances.ts"))).toBe(true);
    expect(existsSync(join(root, "clients", "host", "main.ts"))).toBe(true);
});

test("one home keeps one entry however often it is relaunched", () => {
    const root = tempDir("vera-dev-root-");
    const home = tempHome();
    const source = fileURLToPath(import.meta.url);

    const first = registerDevInstance({ source, home, root });
    const second = registerDevInstance({ source, home, root });

    expect(devInstancePath(home, root)).toBe(devInstancePath(home, root));
    expect(listDevInstances(root)).toEqual([second]);
    expect(first.home).toBe(second.home);
});

test("an entry whose home is gone is dropped as the registry is read", () => {
    const root = tempDir("vera-dev-root-");
    const kept = tempHome();
    const removed = tempHome();
    const source = fileURLToPath(import.meta.url);
    registerDevInstance({ source, home: kept, root });
    registerDevInstance({ source, home: removed, root });
    expect(listDevInstances(root)).toHaveLength(2);

    rmSync(removed, { recursive: true, force: true });

    expect(listDevInstances(root).map((entry) => entry.home)).toEqual([kept]);
});

test("an entry whose home is now a file is dropped, by the entry's own path", () => {
    const root = tempDir("vera-dev-root-");
    const kept = tempHome();
    const replaced = tempHome();
    const source = fileURLToPath(import.meta.url);
    registerDevInstance({ source, home: kept, root });
    const record = registerDevInstance({ source, home: replaced, root });
    const manual = join(devInstanceDirectory(root), "manual.json");
    writeFileSync(manual, `${JSON.stringify(record)}\n`);

    rmSync(replaced, { recursive: true, force: true });
    writeFileSync(replaced, "not a directory\n");

    expect(listDevInstances(root).map((entry) => entry.home)).toEqual([kept]);
    expect(existsSync(devInstancePath(replaced, root))).toBe(false);
    expect(existsSync(manual)).toBe(false);
});

test("an unreadable entry is discarded, not thrown over", () => {
    const root = tempDir("vera-dev-root-");
    const home = tempHome();
    registerDevInstance({ source: fileURLToPath(import.meta.url), home, root });
    const directory = devInstanceDirectory(root);
    writeFileSync(join(directory, "junk.json"), "{not json");
    writeFileSync(
        join(directory, "old.json"),
        JSON.stringify({ schema_version: 0, home }),
    );

    expect(listDevInstances(root).map((entry) => entry.home)).toEqual([home]);
});

test("dropping an entry that was never written is not an error", () => {
    const root = tempDir("vera-dev-root-");
    expect(() => dropDevInstance("/nowhere/.vera", root)).not.toThrow();
    expect(listDevInstances(root)).toEqual([]);
});
