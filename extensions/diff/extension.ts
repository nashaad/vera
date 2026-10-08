import { BoxRenderable, type CliRenderer } from "@opentui/core";
import type { VeraClientExtensionApi } from "../../src/sdk/extensions.ts";
import { countChangedFiles, findWorktree, listWorktrees, readFilePatch, readWorkspaceDiff, type WorkspaceDiff, type Worktree } from "./model.ts";
import { createDiffView, type DiffView } from "./view.ts";
import { createWorktreePicker, worktreeLabel, type WorktreePicker } from "./worktrees.ts";

const USAGE = "Usage: /diff [worktree]";

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function viewLabel(worktree: Worktree | undefined): string | undefined {
    if (!worktree) return undefined;
    return `${worktree.name} · ${worktreeLabel(worktree)}${worktree.current ? "" : " · other worktree"}`;
}

export function activateClient(vera: VeraClientExtensionApi): void {
    let cancel: (() => void) | undefined;
    vera.conversation.onChanged(() => cancel?.());
    vera.onDispose(() => cancel?.());
    vera.commands.register({
        name: "diff",
        description: "Browse changed files and patches in this workspace or another worktree",
        usage: "/diff [worktree]",
        interactive: true,
        palette: { label: "View workspace diff", group: "Session" },
        async run({ argumentsText, workspace, signal }) {
            const query = argumentsText.trim();
            if (/\s/.test(query)) return { kind: "text", text: USAGE };
            const controller = new AbortController();
            const abort = (): void => controller.abort();
            signal.addEventListener("abort", abort, { once: true });
            cancel = abort;
            try {
                let worktrees: Worktree[] = [];
                try { worktrees = await listWorktrees(workspace, controller.signal); }
                catch (error) { if (query) throw error; }
                let shown = worktrees.findIndex((worktree) => worktree.current);
                if (query) {
                    const matches = await findWorktree(worktrees, query, workspace);
                    if (matches.length === 0) return { kind: "text", text: `No worktree matches "${query}". Open /diff and press w to choose one.` };
                    if (matches.length > 1) return { kind: "text", text: `Several worktrees match "${query}":\n${matches.map((worktree) => `  ${worktree.path}`).join("\n")}\nUse the folder path to choose one.` };
                    shown = worktrees.indexOf(matches[0]!);
                }
                const first = await readWorkspaceDiff(worktrees[shown]?.path ?? workspace, controller.signal);
                controller.signal.throwIfAborted();

                let renderer: CliRenderer | undefined;
                let frame: BoxRenderable | undefined;
                let view: DiffView | undefined;
                let picker: WorktreePicker | undefined;
                let load: AbortController | undefined;
                let pick: AbortController | undefined;
                let reading: AbortController | undefined;
                let finish: () => void = () => {};
                const closed = new Promise<void>((resolve) => { finish = resolve; });
                controller.signal.addEventListener("abort", finish, { once: true });

                const showDiff = (snapshot: WorkspaceDiff): void => {
                    if (!renderer || !frame || controller.signal.aborted) return;
                    load?.abort();
                    view?.root.destroyRecursively();
                    const patches = new AbortController();
                    load = patches;
                    const created = createDiffView(renderer, snapshot, abort, {
                        label: viewLabel(worktrees[shown]),
                        chooseWorktree: worktrees.length > 1 ? openPicker : undefined,
                    });
                    view = created;
                    frame.add(created.root);
                    void (async () => {
                        for (let index = 0; index < snapshot.files.length; index++) {
                            if (patches.signal.aborted) break;
                            try { created.setPatch(index, await readFilePatch(snapshot, snapshot.files[index]!, patches.signal)); }
                            catch (error) {
                                if (!patches.signal.aborted) created.setPatch(index, `Could not load patch: ${errorText(error)}`);
                            }
                        }
                    })();
                };
                const closePicker = (): void => {
                    pick?.abort();
                    picker?.root.destroyRecursively();
                    picker = undefined;
                    if (view) view.root.visible = true;
                };
                // The latest choice wins: each Enter cancels the read still running for the previous one.
                const choose = async (index: number, reads: AbortController): Promise<void> => {
                    const worktree = worktrees[index];
                    if (!worktree) return;
                    reading?.abort();
                    if (index === shown) { closePicker(); return; }
                    const read = new AbortController();
                    reading = read;
                    const signal = AbortSignal.any([reads.signal, read.signal]);
                    picker?.setMessage(`Reading ${worktree.name}…`);
                    try {
                        const snapshot = await readWorkspaceDiff(worktree.path, signal);
                        if (signal.aborted) return;
                        shown = index;
                        closePicker();
                        showDiff(snapshot);
                    } catch (error) {
                        if (!signal.aborted) picker?.setMessage(`Could not read ${worktree.name}: ${errorText(error)}`);
                    }
                };
                function openPicker(): void {
                    if (!renderer || !frame || picker) return;
                    const reads = new AbortController();
                    pick = reads;
                    const created = createWorktreePicker(renderer, worktrees, {
                        shown, back: closePicker,
                        choose: (index) => { void choose(index, reads); },
                    });
                    picker = created;
                    if (view) view.root.visible = false;
                    frame.add(created.root);
                    worktrees.forEach((worktree, index) => {
                        countChangedFiles(worktree.path, reads.signal).then(
                            (count) => { if (!reads.signal.aborted) created.setCount(index, count); },
                            (error: unknown) => { if (!reads.signal.aborted) created.setCount(index, error instanceof Error ? error : new Error(String(error))); },
                        );
                    });
                }

                const dispose = vera.experimentalTui.mountRenderable({
                    id: "diff", slot: "overlay", modal: true, fullscreen: true,
                    create(context) {
                        renderer = context.renderer;
                        frame = new BoxRenderable(context.renderer, { width: "100%", height: "100%", flexDirection: "column" });
                        showDiff(first);
                        return frame;
                    },
                    onKey(key) { return picker ? picker.onKey(key) : view?.onKey(key); },
                });
                try { await closed; }
                finally {
                    load?.abort();
                    pick?.abort();
                    await dispose();
                    controller.signal.removeEventListener("abort", finish);
                }
            } catch (error) {
                if (!controller.signal.aborted) return { kind: "text", text: errorText(error) };
            } finally {
                signal.removeEventListener("abort", abort);
                cancel = undefined;
            }
            return { kind: "handled" };
        },
    });
}
