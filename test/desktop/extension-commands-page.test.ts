import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PickerSheet } from "../../clients/ui/src/overlays/PickerSheet.tsx";
import { closeOverlay, openPicker, openedPicker } from "../../clients/ui/src/overlays/store.ts";
import { ExtensionRowsView } from "../../clients/ui/src/pages/settings/ExtensionRows.tsx";
import type { DesktopMenuItem } from "../../clients/ui/src/protocol/extensions.ts";

afterEach(() => closeOverlay());

const IMPORT_ROW: DesktopMenuItem = {
    command: "vera.vscode-theme-import.import",
    title: "Import a VS Code theme",
    description: "Choose a theme .json file or a .vsix extension package.",
    button: "Import…",
};
const BARE_ROW: DesktopMenuItem = { command: "vera.crow.run", title: "Crow" };

function rows(overrides: Partial<Parameters<typeof ExtensionRowsView>[0]>): string {
    return renderToStaticMarkup(createElement(ExtensionRowsView, { rows: [], busy: false, report: undefined, onRun: () => {}, ...overrides }));
}

test("@core a row of an extension shows its title, description and button, and a row with none says Run", () => {
    const html = rows({ rows: [IMPORT_ROW, BARE_ROW] });
    expect(html).toContain("Import a VS Code theme");
    expect(html).toContain("Choose a theme .json file or a .vsix extension package.");
    expect(html).toMatch(/data-extension-command="vera.vscode-theme-import.import"[^>]*>Import…</);
    expect(html).toMatch(/data-extension-command="vera.crow.run"[^>]*>Run</);
});

test("no rows show nothing, not even a report, and a busy row is disabled", () => {
    expect(rows({ report: { ok: true, message: "Imported." } })).toBe("");
    expect(rows({ rows: [IMPORT_ROW], busy: true })).toMatch(/disabled=""[^>]*data-extension-command|data-extension-command[^>]*disabled=""/);
    expect(rows({ rows: [IMPORT_ROW] })).not.toContain("disabled");
});

test("a report shows under the rows and says whether it went well", () => {
    const failed = rows({ rows: [IMPORT_ROW], report: { ok: false, message: "The file is not valid JSON. Your theme is unchanged." } });
    expect(failed).toContain("The file is not valid JSON. Your theme is unchanged.");
    expect(failed).toContain('data-import-ok="false"');
    expect(rows({ rows: [IMPORT_ROW], report: { ok: true, message: "Imported." } })).toContain('data-import-ok="true"');
});

test("the picker store holds one request, a new one replaces it, and closing clears it", () => {
    const first = { title: "First", items: [], cut: false, choose: () => {} };
    openPicker(first);
    expect(openedPicker()).toBe(first);
    const second = { ...first, title: "Second" };
    openPicker(second);
    expect(openedPicker()).toBe(second);
    closeOverlay();
    expect(openedPicker()).toBeUndefined();
});

test("the picker sheet lists the items with their details, and notes a cut list", () => {
    const request = {
        title: "Themes installed in VS Code",
        items: [{ key: "pick-0", label: "Crow Nest", detail: "Crow Pack" }, { key: "pick-1", label: "Pirate Crow" }],
        cut: true,
        choose: () => {},
    };
    const html = renderToStaticMarkup(createElement(PickerSheet, { request, onClose: () => {} }));
    expect(html).toContain('aria-label="Themes installed in VS Code"');
    expect(html).toContain('data-overlay="picker"');
    expect(html).toContain('data-pick="pick-0"');
    expect(html).toContain('data-pick="pick-1"');
    expect(html).toContain("Crow Pack");
    expect(html).toContain("More themes are installed than this list shows.");
    expect(html).toContain('placeholder="Type to filter"');
    const whole = renderToStaticMarkup(createElement(PickerSheet, { request: { ...request, items: [], cut: false }, onClose: () => {} }));
    expect(whole).toContain("No matches");
    expect(whole).not.toContain("More themes");
});
