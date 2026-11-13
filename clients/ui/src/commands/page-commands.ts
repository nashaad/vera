import { ANNEX_BUILT_IN_PAGES, type AnnexPageId } from "../../../../src/annex/built-in-pages.ts";
import type { CommandRegistry } from "./registry.ts";

export const PAGE_COMMANDS = {
    all: "page.all",
    usage: "page.usage",
    runs: "page.runs",
} as const satisfies Record<"all" | AnnexPageId, string>;

export interface PageCommandTarget {
    // Opens an entry in the right pane browser and shows the pane.
    readonly open: (entry: string) => void;
}

export function registerPageCommands(registry: CommandRegistry, target: PageCommandTarget): () => void {
    const disposers = [
        registry.register({ id: PAGE_COMMANDS.all, title: "Vera's Pages", run: () => target.open("") }),
        ...ANNEX_BUILT_IN_PAGES.map((page) => registry.register({
            id: PAGE_COMMANDS[page.id],
            title: page.label,
            run: () => target.open(page.href),
        })),
    ];
    return () => {
        for (const dispose of disposers) dispose();
    };
}
