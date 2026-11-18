import { ANNEX_BUILT_IN_PAGES, type AnnexPageId } from "../../../../src/annex/built-in-pages.ts";
import type { AnnexPage } from "../protocol/bridge.ts";
import type { CommandRegistry } from "./registry.ts";

export const PAGE_COMMANDS = {
    all: "page.all",
    usage: "page.usage",
    runs: "page.runs",
} as const satisfies Record<"all" | AnnexPageId, string>;

export interface PageCommandTarget {
    readonly open: (page: AnnexPage, path: string) => void;
    readonly list: (pages: readonly AnnexPage[]) => void;
}

export function registerPageCommands(registry: CommandRegistry, target: PageCommandTarget, pages: readonly AnnexPage[]): () => void {
    const available = ANNEX_BUILT_IN_PAGES.map((builtin) => pages.find((page) => page.path === builtin.href) ?? {
        label: builtin.label,
        path: builtin.href,
    });
    const listed = new Set(available.map((page) => page.path));
    for (const page of pages) {
        if (listed.has(page.path)) continue;
        listed.add(page.path);
        available.push(page);
    }
    const disposers = [registry.register({
        id: PAGE_COMMANDS.all,
        title: "Vera's Pages",
        run: () => target.list(available),
    })];
    disposers.push(...available.map((page) => {
        const builtin = ANNEX_BUILT_IN_PAGES.find((candidate) => candidate.href === page.path);
        const id = builtin === undefined ? `page.extension.${encodeURIComponent(page.path)}` : PAGE_COMMANDS[builtin.id];
        return registry.register({ id, title: page.label, run: () => target.open(page, page.path) });
    }));
    return () => {
        for (const dispose of disposers) dispose();
    };
}
