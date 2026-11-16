import { afterAll, expect, test } from "bun:test";
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
    SEARCH_DEPTH,
    scanNestedProtectedPaths,
} from "../../src/sandbox/protected-scan.ts";

const roots: string[] = [];

afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tree(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-protected-scan-"));
    roots.push(root);
    return root;
}

function file(...parts: string[]): void {
    const path = join(...parts);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "x");
}

test("@core the protected scan finds srt's names at srt's depth", () => {
    const root = tree();
    file(root, "sub", ".git", "HEAD");
    file(root, "sub", ".git", "config");
    file(root, "sub", ".git", "hooks", "pre-commit");
    file(root, "sub", ".vscode", "settings.json");
    file(root, "a", "b", ".bashrc");
    // Too deep for a dangerous file, and a directory name one level shallower.
    file(root, "a", "b", "c", ".bashrc");
    file(root, "a", "b", ".vscode", "settings.json");
    // Ignored the way srt ignores it.
    file(root, "node_modules", ".vscode", "settings.json");

    const result = scanNestedProtectedPaths({
        roots: [root],
        protectedFiles: [".bashrc"],
        protectedDirectories: [".vscode"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const found = new Set(result.paths);
    expect(found).toContain(join(root, "sub", ".git", "hooks"));
    expect(found).toContain(join(root, "sub", ".git", "config"));
    expect(found).toContain(join(root, "sub", ".vscode"));
    expect(found).toContain(join(root, "a", "b", ".bashrc"));
    expect(found).not.toContain(join(root, "a", "b", "c", ".bashrc"));
    expect(found).not.toContain(join(root, "a", "b", ".vscode"));
    expect(found).not.toContain(join(root, "node_modules", ".vscode"));
});

test("@core the protected scan protects a nested repository's hooks before they exist", () => {
    const root = tree();
    file(root, "sub", ".git", "HEAD");

    const result = scanNestedProtectedPaths({
        roots: [root],
        protectedFiles: [],
        protectedDirectories: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.paths).toContain(join(root, "sub", ".git", "hooks"));
});

test("@core the protected scan skips symlinked folders", () => {
    const root = tree();
    const outside = tree();
    file(outside, ".vscode", "settings.json");
    symlinkSync(outside, join(root, "link"), "dir");

    const result = scanNestedProtectedPaths({
        roots: [root],
        protectedFiles: [],
        protectedDirectories: [".vscode"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.paths.some((path) => path.startsWith(join(root, "link")))).toBe(false);
});

test("@core the protected scan fails rather than run with fewer denies", () => {
    const missing = scanNestedProtectedPaths({
        roots: [join(tmpdir(), "vera-protected-scan-missing-folder")],
        protectedFiles: [],
        protectedDirectories: [],
    });
    expect(missing.ok).toBe(false);

    const root = tree();
    file(root, "sub", ".git", "HEAD");
    let clock = 0;
    const timedOut = scanNestedProtectedPaths({
        roots: [root],
        protectedFiles: [],
        protectedDirectories: [],
        budgetMs: 1,
        now: () => (clock += 10),
    });
    expect(timedOut.ok).toBe(false);
    if (!timedOut.ok) expect(timedOut.reason).toContain("time limit");
});

test("@core the scan depth matches the pinned runtime's constant", () => {
    const source = readFileSync(
        new URL(
            "../../node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js",
            import.meta.url,
        ),
        "utf8",
    );
    const match = /DEFAULT_MANDATORY_DENY_SEARCH_DEPTH\s*=\s*(\d+)/.exec(source);
    expect(match?.[1]).toBe(String(SEARCH_DEPTH));
});

test("@core an unreadable folder this user owns is denied whole", () => {
    // Root reads every mode, so there is nothing unreadable to test as root.
    if (process.getuid?.() === 0) return;
    // The temp container refuses lstat of a mode-000 folder; a home folder
    // behaves like an ordinary filesystem.
    const root = mkdtempSync(join(homedir(), "vera-protected-scan-"));
    roots.push(root);
    file(root, "sub", "inside.txt");
    const locked = join(root, "sub");
    chmodSync(locked, 0o000);
    try {
        const result = scanNestedProtectedPaths({
            roots: [root],
            protectedFiles: [".bashrc"],
            protectedDirectories: [".vscode"],
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.paths).toContain(locked);
    } finally {
        chmodSync(locked, 0o755);
    }
});
