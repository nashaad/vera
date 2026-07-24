import { afterEach, expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectReviewerPathFacts } from "../../src/engine/reviewer-path-facts.ts";
import type { PermissionActionDecision } from "../../src/engine/permissions.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const path of temporaryDirectories.splice(0)) {
        rmSync(path, { recursive: true, force: true });
    }
});

test("reviewer path facts describe files and bounded directory trees without content", async () => {
    const root = temporaryDirectory();
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    mkdirSync(workspace);
    mkdirSync(join(outside, "nested"), { recursive: true });
    writeFileSync(join(outside, "first.txt"), "abc");
    writeFileSync(join(outside, "nested", "second.txt"), "de");

    const facts = await collectReviewerPathFacts(
        workspace,
        {
            id: "write-outside",
            name: "write",
            input: { path: "../outside" },
        },
        [pathAction(outside)],
    );

    expect(facts[0]).toEqual({
        requestedPath: "../outside",
        resolvedPath: realpathSync(outside),
        scope: "outside_workspace",
        exists: true,
        type: "directory",
        entryCount: 3,
        totalBytes: 5,
        truncated: false,
        trackedGitState: "not_repository",
    });
    expect(JSON.stringify(facts)).not.toContain("abc");
    expect(JSON.stringify(facts)).not.toContain("first.txt");
});

test("reviewer path facts disclose a symlink target and a missing destination", async () => {
    const root = temporaryDirectory();
    const workspace = join(root, "workspace");
    const target = join(root, "target.txt");
    const link = join(workspace, "linked.txt");
    mkdirSync(workspace);
    writeFileSync(target, "target");
    symlinkSync(target, link);

    const linked = await collectReviewerPathFacts(
        workspace,
        {
            id: "read-link",
            name: "read",
            input: { path: "linked.txt" },
        },
        [pathAction(target, "read")],
    );
    expect(linked[0]).toMatchObject({
        requestedPath: "linked.txt",
        resolvedPath: realpathSync(target),
        scope: "outside_workspace",
        exists: true,
        type: "symbolic_link",
        symlinkTarget: realpathSync(target),
    });

    const missingPath = join(root, "new-note.md");
    const missing = await collectReviewerPathFacts(
        workspace,
        {
            id: "write-missing",
            name: "write",
            input: { path: "../new-note.md", content: "new" },
        },
        [pathAction(missingPath)],
    );
    expect(missing[0]).toMatchObject({
        requestedPath: "../new-note.md",
        resolvedPath: missingPath,
        scope: "outside_workspace",
        exists: false,
        type: "missing",
    });
});

test("reviewer directory facts stop at the fixed metadata bound", async () => {
    const root = temporaryDirectory();
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    mkdirSync(workspace);
    mkdirSync(outside);
    for (let index = 0; index < 1_001; index += 1) {
        writeFileSync(join(outside, `entry-${index}`), "");
    }

    const facts = await collectReviewerPathFacts(
        workspace,
        {
            id: "bounded-directory",
            name: "write",
            input: { path: "../outside" },
        },
        [pathAction(outside)],
    );

    expect(facts[0]).toMatchObject({
        entryCount: 1_000,
        totalBytes: 0,
        truncated: true,
    });
});

test("reviewer path inspection stops before work when the turn is cancelled", async () => {
    const root = temporaryDirectory();
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const controller = new AbortController();
    controller.abort();

    await expect(collectReviewerPathFacts(
        workspace,
        {
            id: "cancelled",
            name: "write",
            input: { path: "../outside.txt", content: "new" },
        },
        [pathAction(join(root, "outside.txt"))],
        controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
});

function temporaryDirectory(): string {
    const path = mkdtempSync(join(tmpdir(), "vera-review-path-facts-"));
    temporaryDirectories.push(path);
    return path;
}

function pathAction(
    path: string,
    verb: "read" | "write" = "write",
): PermissionActionDecision {
    return {
        action: {
            tool: verb,
            verb,
            path,
            scope: "outside_workspace",
        },
        outcome: "review",
        rule: "profile.default",
    };
}
