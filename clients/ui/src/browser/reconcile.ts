export interface ReconcileInput {
    // The slots that have a view to show them: the pane's Browser tabs, and a Browser view placed elsewhere.
    readonly live: readonly string[];
    // Every slot held, and the page each shows; a slot with none shows one of Vera's own pages.
    readonly bound: Readonly<Record<string, number | undefined>>;
    // The pages the shell has open, and the one it shows.
    readonly pages: readonly number[];
    readonly active: number | null;
    // How many more Browser tabs the pane can open.
    readonly room: number;
}

export interface ReconcilePlan {
    // Live slots whose page is gone.
    readonly closeSlots: readonly string[];
    // Pages no live slot shows that get a tab of their own, in order, the shell's active page last.
    readonly adopt: readonly number[];
    // Pages with no live slot to show them and no room for a tab.
    readonly closePages: readonly number[];
    // Slots to forget: those with no view, and those whose page is gone.
    readonly dropSlots: readonly string[];
}

// Keeps tabs and pages one to one: a tab follows its page, and a page follows its tab.
export function reconcile(input: ReconcileInput): ReconcilePlan {
    const open = new Set(input.pages);
    const live = new Set(input.live);
    const closeSlots = input.live.filter((key) => {
        const page = input.bound[key];
        return page !== undefined && !open.has(page);
    });
    const shown = new Set<number>();
    const orphaned = new Set<number>();
    const dropSlots: string[] = [];
    for (const [key, page] of Object.entries(input.bound)) {
        if (!live.has(key)) dropSlots.push(key);
        if (page === undefined || !open.has(page)) continue;
        if (live.has(key)) shown.add(page);
        else orphaned.add(page);
    }
    const strays = input.pages.filter((page) => !shown.has(page) && !orphaned.has(page));
    const ordered = [...strays.filter((page) => page !== input.active), ...strays.filter((page) => page === input.active)];
    // The pages that get a tab are the last ones, so the page the shell shows is never the one left out.
    const cut = Math.max(0, ordered.length - Math.max(0, input.room));
    return {
        closeSlots,
        adopt: ordered.slice(cut),
        closePages: [...orphaned, ...ordered.slice(0, cut)],
        dropSlots: [...new Set([...dropSlots, ...closeSlots])],
    };
}
