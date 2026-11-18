import { expect, test } from "bun:test";

import { PAGE_COMMANDS, registerPageCommands } from "../../clients/ui/src/commands/page-commands.ts";
import { showPagePicker } from "../../clients/ui/src/commands/page-picker.ts";
import { CommandRegistry } from "../../clients/ui/src/commands/registry.ts";
import { buildCommandItems } from "../../clients/ui/src/overlays/palette.ts";
import { closePicker, openedPicker } from "../../clients/ui/src/overlays/store.ts";
import type { AnnexPage } from "../../clients/ui/src/protocol/bridge.ts";

const USAGE: AnnexPage = { label: "Usage", path: "/usage" };
const RUNS: AnnexPage = { label: "Workflow runs", path: "/runs" };
const EXTENSION: AnnexPage = { label: "Artifacts", path: "/x/vera.artifacts/artifacts", extensionId: "vera.artifacts", pane: true };

test("@core each available annex page has a Pages command routed through the opener", () => {
    const registry = new CommandRegistry();
    const opened: string[] = [];
    const dispose = registerPageCommands(registry, { open: (page, path) => opened.push(`${page.path}:${path}`), list: () => {} }, [USAGE, RUNS, EXTENSION]);
    for (const id of [PAGE_COMMANDS.usage, PAGE_COMMANDS.runs, "page.extension.%2Fx%2Fvera.artifacts%2Fartifacts"]) registry.execute(id);
    expect(opened).toEqual(["/usage:/usage", "/runs:/runs", `${EXTENSION.path}:${EXTENSION.path}`]);

    const items = buildCommandItems(registry.list(), "darwin");
    expect(items.map((item) => [item.group, item.label])).toEqual([
        ["Pages", "Artifacts"],
        ["Pages", "Usage"],
        ["Pages", "Vera's Pages"],
        ["Pages", "Workflow runs"],
    ]);
    dispose();
    expect(registry.list()).toEqual([]);
});

test("@core Vera's Pages lists all pages and opens the chosen page", () => {
    const registry = new CommandRegistry();
    const plain: AnnexPage = { label: "Ledger", path: "/x/acme/ledger", extensionId: "acme" };
    const opened: string[] = [];
    const dispose = registerPageCommands(registry, {
        open: (_page, path) => opened.push(path),
        list: (pages) => showPagePicker(pages, (page) => opened.push(page.path)),
    }, [USAGE, RUNS, EXTENSION, plain]);
    expect(registry.execute(PAGE_COMMANDS.all)).toBe(true);
    const picker = openedPicker();
    expect(picker?.title).toBe("Vera's Pages");
    expect(picker?.items.map((item) => item.key)).toEqual([USAGE.path, RUNS.path, EXTENSION.path, plain.path]);
    picker?.choose(plain.path);
    expect(opened).toEqual([plain.path]);
    closePicker();
    dispose();
});

test("built-in page commands register before the annex page list arrives", () => {
    const registry = new CommandRegistry();
    const opened: string[] = [];
    const dispose = registerPageCommands(registry, { open: (_page, path) => opened.push(path), list: () => {} }, []);

    expect(registry.execute(PAGE_COMMANDS.usage)).toBe(true);
    expect(registry.execute(PAGE_COMMANDS.runs)).toBe(true);
    expect(opened).toEqual(["/usage", "/runs"]);
    dispose();
});
