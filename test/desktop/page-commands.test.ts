import { expect, test } from "bun:test";

import { PAGE_COMMANDS, registerPageCommands } from "../../clients/ui/src/commands/page-commands.ts";
import { CommandRegistry } from "../../clients/ui/src/commands/registry.ts";
import { buildCommandItems } from "../../clients/ui/src/overlays/palette.ts";

test("@core each of Vera's own pages has a command that opens it in the browser", () => {
    const registry = new CommandRegistry();
    const opened: string[] = [];
    const dispose = registerPageCommands(registry, { open: (entry) => opened.push(entry) });
    for (const id of [PAGE_COMMANDS.usage, PAGE_COMMANDS.runs, PAGE_COMMANDS.all]) registry.execute(id);
    expect(opened).toEqual(["/usage", "/runs", ""]);

    const items = buildCommandItems(registry.list(), "darwin");
    expect(items.map((item) => [item.group, item.label])).toEqual([
        ["Pages", "Runs"],
        ["Pages", "Usage"],
        ["Pages", "Vera's Pages"],
    ]);
    dispose();
    expect(registry.list()).toEqual([]);
});
