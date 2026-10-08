import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { startClientExtensionRegistry } from "../../src/extensions/client-registry.ts";
import { createTuiExperimentalHost } from "../../clients/tui/experimental-tui-host.ts";
import { VERA_TUI_THEME } from "../../clients/tui/theme.ts";

const directories: string[] = [];
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(root: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function ship(): { root: string; plunder: string } {
    const root = mkdtempSync(join(tmpdir(), "vera-diff-worktrees-"));
    directories.push(root);
    git(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, ".gitignore"), ".worktrees/\n");
    writeFileSync(join(root, "log.txt"), "day one\n");
    git(root, "add", ".");
    git(root, "-c", "user.name=nashaad", "-c", "user.email=nashaad@gmail.com", "-c", "commit.gpgsign=false", "commit", "-qm", "test: seed");
    const plunder = join(root, ".worktrees", "plunder");
    git(root, "worktree", "add", "-q", "-b", "feat/plunder", plunder);
    writeFileSync(join(root, "log.txt"), "day one\nthe crow sees land\n");
    writeFileSync(join(plunder, "chest.txt"), "shiny buttons\n");
    return { root, plunder };
}

async function session(workspace: string) {
    const setup = await createTestRenderer({ width: 120, height: 30 });
    const failures: string[] = [];
    const host = createTuiExperimentalHost({
        renderer: setup.renderer, theme: VERA_TUI_THEME, workspace: () => workspace,
        transcript: () => [], onFailure: (_id, message) => failures.push(message), onRenderRequested() {},
    });
    const registry = await startClientExtensionRegistry({
        extensions: [{ path: resolve(import.meta.dir, "../../extensions/diff"), enabled: true, config: {} }],
        preferences: { async get() { return undefined; }, async set() {}, async delete() {} },
        modelSettings: { current: () => undefined, async update() { return { status: "rejected", reason: "unavailable" }; }, subscribe: () => () => {} },
        picker: { async request() { return { outcome: "cancelled" }; } },
        notice: { post() {} }, experimentalTui: host.adapter,
        onFailure: (failure) => failures.push(failure.message),
    });
    const controller = new AbortController();
    const frame = async (): Promise<string> => { host.render(); await setup.flush(); return setup.captureCharFrame(); };
    const waitFor = async (pattern: RegExp): Promise<string> => {
        let text = "";
        for (let attempt = 0; attempt < 200; attempt++) {
            text = await frame();
            if (pattern.test(text)) return text;
            await Bun.sleep(25);
        }
        throw new Error(`Frame never matched ${pattern}:\n${text}`);
    };
    const invoke = (args: string) => registry.invokeCommand("diff", args, workspace, controller.signal);
    const close = async (): Promise<void> => { controller.abort(); await registry.close(); await host.close(); setup.renderer.destroy(); };
    return { host, failures, frame, waitFor, invoke, close };
}

test("w opens the worktree list from the session's worktree, Enter shows the other one, Escape returns", async () => {
    const { root } = ship();
    const vera = await session(root);
    try {
        const invocation = vera.invoke("");
        let text = await vera.waitFor(/the crow sees land/);
        expect(text.split("\n")[0]).toMatch(/Diff  vera-diff-worktrees-\S+ · main\s+1 files/);
        vera.host.handleKey({ name: "w" });
        text = await vera.waitFor(/plunder · feat\/plunder\s+1 file/);
        expect(text).toMatch(/· main · this session\s+1 file/);
        vera.host.handleKey({ name: "escape" });
        text = await vera.frame();
        expect(text).toContain("the crow sees land");
        vera.host.handleKey({ name: "w" });
        await vera.waitFor(/Choose a worktree/);
        vera.host.handleKey({ name: "down" });
        vera.host.handleKey({ name: "return" });
        text = await vera.waitFor(/shiny buttons/);
        expect(text.split("\n")[0]).toMatch(/Diff  plunder · feat\/plunder · other worktree\s+1 files/);
        expect(text).not.toContain("the crow sees land");
        vera.host.handleKey({ name: "escape" });
        expect(await invocation).toMatchObject({ body: { kind: "handled" } });
        expect(vera.host.hasModal()).toBe(false);
        expect(vera.failures).toEqual([]);
    } finally { await vera.close(); }
});

test("/diff with a folder or branch name opens that worktree; unknown names explain what to do", async () => {
    const { root } = ship();
    const vera = await session(root);
    try {
        for (const name of ["plunder", "feat/plunder"]) {
            const invocation = vera.invoke(name);
            const text = await vera.waitFor(/shiny buttons/);
            expect(text.split("\n")[0]).toContain("other worktree");
            vera.host.handleKey({ name: "escape" });
            expect(await invocation).toMatchObject({ body: { kind: "handled" } });
        }
        expect(await vera.invoke("kraken")).toMatchObject({ body: { kind: "text", text: 'No worktree matches "kraken". Open /diff and press w to choose one.' } });
        expect(await vera.invoke("two words")).toMatchObject({ body: { kind: "text", text: "Usage: /diff [worktree]" } });
    } finally { await vera.close(); }
});

test("a repository with one worktree keeps the plain diff and no worktree hint", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-diff-alone-"));
    directories.push(root);
    git(root, "init", "-q", "-b", "main");
    const vera = await session(root);
    try {
        const invocation = vera.invoke("");
        const text = await vera.waitFor(/No changes in this worktree\./);
        expect(text).not.toContain("Press w");
        vera.host.handleKey({ name: "w" });
        expect(await vera.frame()).not.toContain("Choose a worktree");
        vera.host.handleKey({ name: "escape" });
        expect(await invocation).toMatchObject({ body: { kind: "handled" } });
    } finally { await vera.close(); }
});

test("choosing a second worktree while the first is still reading shows the second", async () => {
    const { root } = ship();
    const slow = join(root, ".worktrees", "wreck");
    git(root, "worktree", "add", "-q", "-b", "feat/wreck", slow);
    mkdirSync(join(slow, "barnacles"));
    for (let index = 0; index < 3000; index++) writeFileSync(join(slow, "barnacles", `b${index}.txt`), "x\n");
    writeFileSync(join(slow, "aaa.txt"), "sunken gold\n");
    const vera = await session(root);
    try {
        const invocation = vera.invoke("");
        await vera.waitFor(/the crow sees land/);
        vera.host.handleKey({ name: "w" });
        const text = await vera.waitFor(/wreck · feat\/wreck\s+\d+ files/);
        const rows = text.split("\n").filter((line) => /plunder · |wreck · /.test(line));
        const plunderFirst = rows[0]!.includes("plunder");
        const order = plunderFirst ? ["plunder", "wreck"] : ["wreck", "plunder"];
        vera.host.handleKey({ name: "down" }); vera.host.handleKey({ name: "return" });
        vera.host.handleKey({ name: "down" }); vera.host.handleKey({ name: "return" });
        const last = order[1]!;
        await vera.waitFor(new RegExp(`Diff  ${last} · `));
        await Bun.sleep(1000);
        expect((await vera.frame()).split("\n")[0]).toContain(`Diff  ${last} · `);
        vera.host.handleKey({ name: "escape" });
        expect(await invocation).toMatchObject({ body: { kind: "handled" } });
        expect(vera.failures).toEqual([]);
    } finally { await vera.close(); }
});
