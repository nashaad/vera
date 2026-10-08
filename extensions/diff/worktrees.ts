import { BoxRenderable, ScrollBoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import type { VeraExperimentalTuiKey } from "../../src/sdk/experimental-tui.ts";
import { dialogOptionRow } from "../../clients/tui/dialog-chrome.ts";
import { TUI_BACKGROUND, TUI_MUTED, TUI_TEXT } from "../../clients/tui/palette.ts";
import type { Worktree } from "./model.ts";

export interface WorktreePicker {
    root: BoxRenderable;
    setCount(index: number, count: number | Error): void;
    setMessage(message: string): void;
    onKey(key: VeraExperimentalTuiKey): boolean;
}

export interface WorktreePickerOptions {
    shown: number;
    choose(index: number): void;
    back(): void;
}

export function worktreeLabel(worktree: Worktree): string {
    return worktree.branch ?? `detached at ${worktree.head?.slice(0, 7) ?? "unknown"}`;
}

export function createWorktreePicker(renderer: CliRenderer, worktrees: readonly Worktree[], options: WorktreePickerOptions): WorktreePicker {
    const root = new BoxRenderable(renderer, { id: "diff-worktrees", width: "100%", height: "100%", backgroundColor: TUI_BACKGROUND, flexDirection: "column", focusable: true });
    const heading = new TextRenderable(renderer, { content: " Diff  Choose a worktree", fg: TUI_TEXT, height: 1, flexShrink: 0 });
    // Padding lives on the body, not the scroll box, so row index equals content line in reveal().
    const body = new BoxRenderable(renderer, { flexGrow: 1, minHeight: 0, flexDirection: "column", paddingTop: 1, paddingLeft: 1, paddingRight: 1, border: ["top", "bottom"], borderColor: TUI_MUTED });
    const list = new ScrollBoxRenderable(renderer, { id: "diff-worktree-list", flexGrow: 1, minHeight: 0, scrollX: false, scrollY: true, verticalScrollbarOptions: { visible: false }, horizontalScrollbarOptions: { visible: false } });
    const footer = new TextRenderable(renderer, { content: " ↑↓ choose · enter open · esc back", fg: TUI_MUTED, height: 1, flexShrink: 0, wrapMode: "none" });
    root.add(heading); root.add(body); root.add(footer);
    body.add(list);
    const counts = new Map<number, number | Error>();
    const names = worktrees.map((worktree) => worktree.name);
    let highlight = Math.max(0, Math.min(options.shown, worktrees.length - 1));
    let message = "";

    function countText(index: number): string {
        const count = counts.get(index);
        if (count === undefined) return "…";
        if (count instanceof Error) return "unreadable";
        return count === 0 ? "no changes" : count === 1 ? "1 file" : `${count} files`;
    }
    function draw(): void {
        for (const child of list.getChildren()) child.destroyRecursively();
        worktrees.forEach((worktree, index) => {
            const collides = names.filter((name) => name === worktree.name).length > 1;
            const notes = [worktreeLabel(worktree), ...(collides ? [worktree.path] : []), ...(worktree.current ? ["this session"] : [])];
            list.add(dialogOptionRow(renderer, {
                label: worktree.name, note: ` · ${notes.join(" · ")}`, meta: `  ${countText(index)} `,
                active: index === highlight, leading: index === highlight ? "› " : index === options.shown ? "• " : "  ",
                onSelect: () => { highlight = index; draw(); options.choose(index); },
            }));
        });
        if (message) list.add(new TextRenderable(renderer, { content: `\n ${message}`, fg: TUI_MUTED, wrapMode: "word", width: "100%" }));
        reveal();
    }
    function reveal(): void {
        const height = list.viewport.height;
        if (height <= 0) return;
        if (highlight < list.scrollTop) list.scrollTo(highlight);
        if (highlight >= list.scrollTop + height) list.scrollTo(highlight - height + 1);
    }
    // The first draw runs before layout, when the viewport has no height yet; content resizes last.
    list.content.on("resize", reveal);
    draw();
    return {
        root,
        setCount(index, count) { if (root.isDestroyed) return; counts.set(index, count); draw(); },
        setMessage(text) { if (root.isDestroyed) return; message = text; draw(); },
        onKey(key) {
            if (key.ctrl || key.meta) return false;
            if (key.name === "escape" || key.name === "q" || key.name === "w") { options.back(); return true; }
            if (key.name === "up" || key.name === "k") { highlight = Math.max(0, highlight - 1); draw(); return true; }
            if (key.name === "down" || key.name === "j") { highlight = Math.min(worktrees.length - 1, highlight + 1); draw(); return true; }
            if (key.name === "enter" || key.name === "return") { options.choose(highlight); return true; }
            return true;
        },
    };
}
