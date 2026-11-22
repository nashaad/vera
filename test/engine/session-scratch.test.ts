import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionScratchDir, sessionScratchPath, sessionScratchRoot } from "../../src/session-scratch.ts";
import { SessionStore } from "../../src/store/session-store.ts";

test("@core session scratch is isolated by home and does not create the legacy root", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "vera-scratch-home-test-")));
    const temporary = join(root, "temporary");
    const legacyRoot = join(temporary, "vera");
    const previousTmpdir = process.env.TMPDIR;
    mkdirSync(temporary);
    process.env.TMPDIR = temporary;
    try {
        const homes = [join(root, "first"), join(root, "second")] as const;
        for (const home of homes) {
            const sessionPath = join(home, "runtime", "sessions", "same.jsonl");
            mkdirSync(join(home, "runtime", "sessions"), { recursive: true });
            const store = await SessionStore.create(sessionPath, { sessionId: "same", cwd: root });
            const scratch = sessionScratchDir(store.header.id, home);
            expect(scratch).toBe(sessionScratchPath("same", home));
            writeFileSync(join(scratch, "todo.md"), home);
        }
        expect(readFileSync(join(sessionScratchPath("same", homes[0]), "todo.md"), "utf8")).toBe(homes[0]);
        expect(readFileSync(join(sessionScratchPath("same", homes[1]), "todo.md"), "utf8")).toBe(homes[1]);
        expect(existsSync(legacyRoot)).toBe(false);
        expect(() => sessionScratchPath("../escape", homes[0])).toThrow();
    } finally {
        if (previousTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmpdir;
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core legacy scratch is renamed once and an existing destination is preserved", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-scratch-migration-test-"));
    const home = join(root, "home");
    const legacyRoot = join(root, "legacy");
    const legacy = join(legacyRoot, "saved");
    try {
        mkdirSync(legacy, { recursive: true });
        writeFileSync(join(legacy, "todo.md"), "old todo");
        mkdirSync(join(legacy, "spill"));
        writeFileSync(join(legacy, "spill", "part"), "old spill");
        const scratch = sessionScratchDir("saved", home, legacyRoot);
        expect(readFileSync(join(scratch, "todo.md"), "utf8")).toBe("old todo");
        expect(readFileSync(join(scratch, "spill", "part"), "utf8")).toBe("old spill");
        expect(existsSync(legacy)).toBe(false);

        mkdirSync(legacy, { recursive: true });
        writeFileSync(join(legacy, "todo.md"), "second copy");
        expect(sessionScratchDir("saved", home, legacyRoot)).toBe(scratch);
        expect(readFileSync(join(scratch, "todo.md"), "utf8")).toBe("old todo");
        expect(readFileSync(join(legacy, "todo.md"), "utf8")).toBe("second copy");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core redirected runtime and scratch roots cannot select another home", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "vera-scratch-roots-")));
    const home = join(root, "home");
    const external = join(root, "external");
    try {
        mkdirSync(home);
        mkdirSync(external);
        writeFileSync(join(external, "keep"), "outside");
        symlinkSync(external, join(home, "runtime"));
        expect(() => sessionScratchRoot(home)).toThrow("Vera runtime must stay inside its home");
        expect(() => sessionScratchPath("saved", home)).toThrow("Vera runtime must stay inside its home");
        expect(() => sessionScratchDir("saved", home)).toThrow("Vera runtime must stay inside its home");
        rmSync(join(home, "runtime"));
        mkdirSync(join(home, "runtime"));
        symlinkSync(external, join(home, "runtime", "scratch"));
        expect(() => sessionScratchRoot(home)).toThrow("Session scratch must stay inside its home");
        expect(() => sessionScratchPath("saved", home)).toThrow("Session scratch must stay inside its home");
        expect(() => sessionScratchDir("saved", home)).toThrow("Session scratch must stay inside its home");
        expect(readFileSync(join(external, "keep"), "utf8")).toBe("outside");
        expect(readdirSync(external)).toEqual(["keep"]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core a legacy symlink cannot move scratch outside its home", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-scratch-link-test-"));
    const home = join(root, "home");
    const legacyRoot = join(root, "legacy");
    const external = join(root, "external");
    try {
        mkdirSync(legacyRoot, { recursive: true });
        mkdirSync(external);
        writeFileSync(join(external, "todo.md"), "outside");
        symlinkSync(external, join(legacyRoot, "saved"));
        const scratch = sessionScratchDir("saved", home, legacyRoot);
        expect(readdirSync(scratch)).toEqual([]);
        expect(readFileSync(join(external, "todo.md"), "utf8")).toBe("outside");
        expect(existsSync(join(legacyRoot, "saved"))).toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core a failed legacy scratch rename leaves the source and starts empty", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-scratch-migration-fail-"));
    const home = join(root, "home");
    const legacyRoot = join(root, "legacy");
    const legacy = join(legacyRoot, "saved");
    try {
        mkdirSync(legacy, { recursive: true });
        writeFileSync(join(legacy, "todo.md"), "keep this");
        const scratch = sessionScratchDir("saved", home, legacyRoot, () => {
            throw new Error("rename failed");
        });
        expect(readdirSync(scratch)).toEqual([]);
        expect(readFileSync(join(legacy, "todo.md"), "utf8")).toBe("keep this");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
