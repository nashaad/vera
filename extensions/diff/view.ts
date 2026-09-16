import { BoxRenderable, DiffRenderable, ScrollBoxRenderable, SyntaxStyle, TextRenderable, type CliRenderer } from "@opentui/core";
import type { VeraExperimentalTuiKey } from "../../src/sdk/experimental-tui.ts";
import { tuiBindingId } from "../../clients/tui/keymap.ts";
import { createTuiDiff } from "../../clients/tui/diff.ts";
import { TUI_ACCENT, TUI_BACKGROUND, TUI_MUTED, TUI_PANEL, TUI_TEXT } from "../../clients/tui/state.ts";
import { fileCounts, type WorkspaceDiff } from "./model.ts";
import { fileRows, fileTree, type FileRow } from "./tree.ts";

export interface DiffView {
    root: BoxRenderable;
    setPatch(index: number, patch: string): void;
    onKey(key: VeraExperimentalTuiKey): boolean;
}

export function createDiffView(renderer: CliRenderer, snapshot: WorkspaceDiff, close: () => void): DiffView {
    const root = new BoxRenderable(renderer, { id: "workspace-diff", width: "100%", height: "100%", backgroundColor: TUI_BACKGROUND, flexDirection: "column", focusable: true });
    const heading = new TextRenderable(renderer, { content: ` Diff  working tree${snapshot.files.length ? `   ${snapshot.files.length} files` : ""}`, fg: TUI_TEXT, height: 1, flexShrink: 0 });
    const body = new BoxRenderable(renderer, { flexDirection: "row", flexGrow: 1, minHeight: 0, border: ["top", "bottom"], borderColor: TUI_MUTED });
    const patches = new ScrollBoxRenderable(renderer, { id: "diff-patches", flexGrow: 1, minWidth: 0, minHeight: 0, paddingLeft: 1, paddingRight: 1, scrollX: false, scrollY: true, verticalScrollbarOptions: { visible: false }, horizontalScrollbarOptions: { visible: false } });
    const sidebar = new ScrollBoxRenderable(renderer, { id: "diff-files", width: 32, flexShrink: 0, border: ["left"], borderColor: TUI_MUTED, scrollX: false, scrollY: true, verticalScrollbarOptions: { visible: false }, horizontalScrollbarOptions: { visible: false }, backgroundColor: TUI_PANEL });
    const footer = new TextRenderable(renderer, { fg: TUI_MUTED, height: 1, flexShrink: 0, wrapMode: "none" });
    root.add(heading); root.add(body); root.add(footer);
    body.add(patches); body.add(sidebar);
    const style = SyntaxStyle.fromStyles({ default: { fg: TUI_TEXT } });
    const tree = fileTree(snapshot.files);
    const expanded = new Set<string>();
    const reviewed = new Set<number>();
    const sections: BoxRenderable[] = [];
    const diffNodes = new Map<number, DiffRenderable>();
    const contents = new Map<number, string>();
    let rows: FileRow[] = [];
    const expandAll = (nodes: typeof tree): void => nodes.forEach((node) => {
        if (node.children.length) expanded.add(node.path);
        expandAll(node.children);
    });
    expandAll(tree);
    let highlight = Math.max(0, fileRows(tree, expanded).findIndex((row) => row.node.fileIndex !== undefined));
    const order = fileRows(tree, expanded).flatMap((row) => row.node.fileIndex === undefined ? [] : [row.node.fileIndex]);
    let selected = order[0] ?? 0;
    let focus: "files" | "patches" = "patches";
    let single = false;
    let viewOverride: "split" | "unified" | undefined;
    let help = false;
    let hunkPosition: { index: number; scroll: number } | undefined;

    function splitView(): "split" | "unified" {
        const width = renderer.width - (sidebar.visible ? 33 : 0) - 2;
        return width >= 100 ? viewOverride ?? "split" : "unified";
    }
    function updateFooter(): void {
        footer.content = help
            ? " n/p file · [/] hunk · b sidebar · s single/all · v split/unified · m reviewed · E expand all · ? back · esc close"
            : ` [${focus === "files" ? "Files" : "Patches"}] ↑↓ scroll · tab focus · enter open · n/p file · ? help · esc close`;
    }
    function drawTree(): void {
        for (const child of sidebar.getChildren()) child.destroyRecursively();
        rows = fileRows(tree, expanded);
        highlight = Math.max(0, Math.min(highlight, rows.length - 1));
        rows.forEach((row, index) => {
            const file = row.node.fileIndex === undefined ? undefined : snapshot.files[row.node.fileIndex];
            const active = focus === "files" && index === highlight;
            const marker = active ? "›" : row.node.fileIndex === selected ? "•" : " ";
            const later = (depth: number): boolean => rows.slice(index + 1).find((item) => item.depth <= depth)?.depth === depth;
            const indent = Array.from({ length: row.depth }, (_, depth) => later(depth) ? "│  " : "   ").join("");
            const branch = index === 0 ? " " : later(row.depth) ? "├─ " : "└─ ";
            const prefix = `${marker}${indent}${branch}${file ? "" : expanded.has(row.node.path) ? "▾ " : "▸ "}`;
            const width = Math.max(1, 27 - prefix.length);
            const name = row.node.name.length > width ? `${row.node.name.slice(0, width - 1)}…` : row.node.name;
            const status = file ? file.untracked ? "?" : file.status.slice(0, 1) : "";
            const mark = row.node.fileIndex !== undefined && reviewed.has(row.node.fileIndex) ? "✓" : " ";
            sidebar.add(new TextRenderable(renderer, {
                id: `diff-file-${index}`, content: `${prefix}${name.padEnd(width)} ${mark}${status}`, height: 1,
                fg: active ? TUI_BACKGROUND : file ? TUI_TEXT : TUI_MUTED,
                bg: active ? TUI_ACCENT : TUI_PANEL, wrapMode: "none",
                onMouseUp() { focus = "files"; highlight = index; openRow(); },
            }));
        });
        if (rows.length === 0) sidebar.add(new TextRenderable(renderer, { content: " No files", fg: TUI_MUTED }));
        if (highlight < sidebar.scrollTop) sidebar.scrollTo(highlight);
        if (highlight >= sidebar.scrollTop + sidebar.viewport.height) sidebar.scrollTo(Math.max(0, highlight - sidebar.viewport.height + 1));
        updateFooter();
    }
    function reveal(index: number): void {
        const file = snapshot.files[index];
        if (!file) return;
        const parts = file.path.split("/");
        for (let i = 1; i < parts.length; i++) expanded.add(parts.slice(0, i).join("/"));
        rows = fileRows(tree, expanded);
        highlight = Math.max(0, rows.findIndex((row) => row.node.fileIndex === index));
        drawTree();
    }
    function jump(index: number): void {
        selected = Math.max(0, Math.min(snapshot.files.length - 1, index));
        reveal(selected);
        sections.forEach((section, i) => { section.visible = !single || i === selected; });
        const section = sections[selected];
        if (single) patches.scrollTo(0);
        else if (section) patches.scrollBy(section.y - patches.viewport.y);
    }
    function openRow(): void {
        const row = rows[highlight];
        if (!row) return;
        if (row.node.fileIndex !== undefined) jump(row.node.fileIndex);
        else {
            if (expanded.has(row.node.path)) expanded.delete(row.node.path);
            else expanded.add(row.node.path);
            drawTree();
        }
    }
    function setPatch(index: number, patch: string): void {
        if (root.isDestroyed) return;
        contents.set(index, patch);
        const section = sections[index];
        const file = snapshot.files[index];
        if (!section || !file) return;
        for (const child of section.getChildren()) child.destroyRecursively();
        section.add(new TextRenderable(renderer, { content: `${file.path}  ${fileCounts(file)}`, fg: TUI_TEXT, width: "100%", wrapMode: "char" }));
        if (/^@@/m.test(patch)) {
            const rendered = createTuiDiff(renderer, `diff-patch-${index}`, file.path, patch, style);
            const path = rendered.getChildren()[0];
            if (path) path.visible = false;
            const diff = rendered.getChildren().find((child): child is DiffRenderable => child instanceof DiffRenderable)!;
            diff.view = splitView();
            diff.wrapMode = "char";
            diffNodes.set(index, diff);
            section.add(rendered);
        } else section.add(new TextRenderable(renderer, { content: patch, fg: TUI_MUTED, width: "100%", wrapMode: "char" }));
    }
    order.forEach((index) => {
        const file = snapshot.files[index]!;
        const section = new BoxRenderable(renderer, { id: `diff-section-${index}`, width: "100%", flexDirection: "column", flexShrink: 0, paddingBottom: 1, border: ["bottom"], borderColor: TUI_MUTED });
        sections[index] = section;
        patches.add(section);
        section.add(new TextRenderable(renderer, { content: `${file.path}  ${fileCounts(file)}\nLoading diff…`, fg: TUI_MUTED }));
    });
    if (snapshot.files.length === 0) patches.add(new TextRenderable(renderer, { content: "No diff!", fg: TUI_MUTED }));
    const resize = (): void => { for (const diff of diffNodes.values()) diff.view = splitView(); };
    renderer.on("resize", resize);
    root.once("destroyed", () => { renderer.off("resize", resize); style.destroy(); });
    drawTree();
    return {
        root, setPatch,
        onKey(key) {
            const binding = tuiBindingId("diff", key);
            if ((key.ctrl || key.meta) && binding !== "diff_page_down" && binding !== "diff_page_up") return false;
            const name = binding === "diff_page_down" ? "pagedown" : binding === "diff_page_up" ? "pageup" : key.name;
            if (name === "[" || name === "]") {
                const hunks: { file: number; y: number }[] = [];
                for (const [file, diff] of diffNodes) {
                    if (single && file !== selected) continue;
                    const origin = patches.scrollTop + diff.y - patches.viewport.y;
                    (contents.get(file) ?? "").split("\n").forEach((line, row) => {
                        if (line.startsWith("@@")) hunks.push({ file, y: origin + row });
                    });
                }
                hunks.sort((a, b) => a.y - b.y);
                const forward = name === "]";
                const cursor = hunkPosition?.scroll === patches.scrollTop ? hunkPosition.index + (forward ? 1 : -1)
                    : forward ? hunks.findIndex((hunk) => hunk.y > patches.scrollTop)
                    : hunks.findLastIndex((hunk) => hunk.y < patches.scrollTop);
                const target = hunks[cursor];
                if (target) { selected = target.file; reveal(selected); patches.scrollTo(target.y); hunkPosition = { index: cursor, scroll: patches.scrollTop }; }
                return true;
            }
            if (name === "escape" || name === "q") { if (help) { help = false; updateFooter(); } else close(); return true; }
            if (name === "tab" || name === "backtab") { if (sidebar.visible) focus = focus === "files" ? "patches" : "files"; drawTree(); return true; }
            if (name === "?") { help = !help; updateFooter(); return true; }
            if (name === "b") { sidebar.visible = !sidebar.visible; if (!sidebar.visible) focus = "patches"; resize(); updateFooter(); return true; }
            if (name === "v") { viewOverride = splitView() === "split" ? "unified" : "split"; resize(); return true; }
            if (name === "s") { single = !single; jump(selected); return true; }
            if (name === "n" || name === "p") {
                const next = Math.max(0, Math.min(order.length - 1, order.indexOf(selected) + (name === "n" ? 1 : -1)));
                if (order[next] !== undefined) jump(order[next]);
                return true;
            }
            if (name === "m") {
                const index = focus === "files" ? rows[highlight]?.node.fileIndex : selected;
                if (index !== undefined) { if (reviewed.has(index)) reviewed.delete(index); else reviewed.add(index); drawTree(); }
                return true;
            }
            if (name === "e" && key.shift || name === "E") {
                expandAll(tree); drawTree(); return true;
            }
            const direction = ["up", "k", "pageup"].includes(name) ? -1 : ["down", "j", "pagedown"].includes(name) ? 1 : 0;
            if (direction) {
                const page = name === "pageup" || name === "pagedown";
                if (focus === "files") { highlight += direction * (page ? 8 : 1); drawTree(); }
                else patches.scrollBy(direction * (page ? patches.viewport.height : 1));
                return true;
            }
            if (focus === "files") {
                if (["enter", "return", "space"].includes(name)) { openRow(); return true; }
                const row = rows[highlight];
                if (row && name === "right") {
                    if (row.node.children.length) { if (expanded.has(row.node.path)) highlight++; else expanded.add(row.node.path); drawTree(); }
                    return true;
                }
                if (row && name === "left") {
                    if (expanded.has(row.node.path)) expanded.delete(row.node.path);
                    else { const parent = row.node.path.split("/").slice(0, -1).join("/"); const index = rows.findIndex((item) => item.node.path === parent); if (index >= 0) highlight = index; }
                    drawTree(); return true;
                }
            }
            return true;
        },
    };
}
