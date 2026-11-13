export type AnnexPageId = "usage" | "runs";

export interface AnnexBuiltInPage {
    readonly id: AnnexPageId;
    readonly label: string;
    readonly href: string;
    readonly about: string;
}

// The annex's own pages, ahead of the ones extensions add through /api/pages.
export const ANNEX_BUILT_IN_PAGES: readonly AnnexBuiltInPage[] = [
    {
        id: "usage",
        label: "Usage",
        href: "/usage",
        about: "Spend, tokens and conversations, read from the session files in your Vera home.",
    },
    {
        id: "runs",
        label: "Runs",
        href: "/runs",
        about: "Workflows that have run in your Vera home, with their steps and cost.",
    },
];
