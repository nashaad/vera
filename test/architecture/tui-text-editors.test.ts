import { expect, test } from "bun:test";

/**
 * Ordinary text surfaces must reach OpenTUI through one of these two shared
 * native paths. Provider/API forms and secret prompts are deliberately absent:
 * their editing behavior is a separate contract.
 */
const ORDINARY_EDITOR_SURFACES = new Map<string, string>([
    ["clients/tui/name-prompt.ts", "createDialogTextFieldNode("],
    ["clients/tui/question.ts", "createTuiSingleLineTextarea("],
    ["clients/tui/command-palette.ts", "createDialogSearchNode("],
    ["clients/tui/help.ts", "createDialogSearchNode("],
    ["clients/tui/timeline-picker.ts", "createDialogSearchNode("],
    ["clients/tui/settings-picker.ts", "createDialogSearchNode("],
    ["clients/tui/search-overlay.ts", "input: {"],
    ["clients/tui/main.ts", 'createTuiLinesView(rt.renderer, "search-overlay"'],
]);

const LEGACY_EDITOR_SYMBOLS = [
    "handleTuiSingleLineEditorKey",
    "insertTuiSingleLineText",
    "renderTuiSingleLineEditor",
];

test("ordinary TUI fields stay on the composer's native editor path", async () => {
    const composer = await Bun.file("clients/tui/composer.ts").text();
    const nativeEditor = await Bun.file(
        "clients/tui/single-line-editor.ts",
    ).text();
    const dialogChrome = await Bun.file("clients/tui/dialog-chrome.ts").text();
    const linesView = await Bun.file("clients/tui/lines-view.ts").text();

    expect(composer).toContain("extends TextareaRenderable");
    expect(nativeEditor).toContain("new TextareaRenderable(");
    expect(nativeEditor).toContain("readonly placeholder: string;");
    expect(dialogChrome).toContain("createTuiSingleLineTextarea(");
    expect(dialogChrome).toContain(
        'return createDialogTextFieldNode(renderer, id, "Search");',
    );
    expect(linesView).toContain("createTuiSingleLineTextarea(");

    for (const [path, nativePath] of ORDINARY_EDITOR_SURFACES) {
        const source = await Bun.file(path).text();
        expect(source).toContain(nativePath);
        for (const legacy of LEGACY_EDITOR_SYMBOLS) {
            expect(source).not.toContain(legacy);
        }
    }

    for await (const path of new Bun.Glob("clients/tui/main/**/*.ts").scan()) {
        const source = await Bun.file(path).text();
        for (const legacy of LEGACY_EDITOR_SYMBOLS) {
            expect(source, path).not.toContain(legacy);
        }
    }
});
