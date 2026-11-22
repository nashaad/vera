import { matchesSettingsQuery } from "./filter.ts";
import { SETTINGS_SECTIONS } from "./sections.ts";
import { SHOW_ROWS } from "./show.ts";
import { FLAG_SPECS } from "../../state/desktopFlags.ts";

export interface SettingsRowEntry {
    readonly sectionId: string;
    // Unique on screen, written as data-setting-id.
    readonly rowId: string;
    readonly name: string;
    readonly description: string;
    // Extra words the search matches beside the name, description and section name.
    readonly terms: string;
}

export type SettingsSearchHit =
    | {
        readonly kind: "row";
        readonly sectionId: string;
        readonly rowId: string;
        readonly name: string;
    }
    | {
        readonly kind: "section";
        readonly sectionId: string;
        readonly name: string;
    };

// Every setting row the search can find. Dynamic lists, such as the agents, workspaces and model roster, are content, not settings.
export const SETTINGS_ROWS: readonly SettingsRowEntry[] = [
    {
        sectionId: "appearance",
        rowId: "appearance.text-size",
        name: "Text size",
        description: "Scales the text of the interface in this window.",
        terms: "font scale bigger smaller",
    },
    {
        sectionId: "appearance",
        rowId: "appearance.code-size",
        name: "Code size",
        description: "Scales code, diffs and code blocks.",
        terms: "font code diff block",
    },
    {
        sectionId: "appearance",
        rowId: "appearance.density",
        name: "Density",
        description: "The space between rows and controls.",
        terms: "compact comfortable spacing",
    },
    {
        sectionId: "appearance",
        rowId: "appearance.reduce-motion",
        name: "Reduce motion",
        description: "Turns off animated transitions in this window.",
        terms: "animation motion off",
    },
    {
        sectionId: "appearance",
        rowId: "appearance.past-approvals",
        name: "Past approvals",
        description: "Keeps each approval's full card in the transcript after you answer it.",
        terms: "approval transcript card history",
    },
    {
        sectionId: "browser",
        rowId: "browser.tools-off",
        name: "When Browser tools are off",
        description: "",
        terms: "browser tool ask refuse chat turn turned off",
    },
    {
        sectionId: "browser",
        rowId: "browser.default-browser",
        name: "Default browser",
        description: "",
        terms: "browser pane chrome open page question each chat",
    },
    {
        sectionId: "agents",
        rowId: "agents.notes-offer",
        name: "Suggest keeping notes",
        description: "New sessions offer once to keep notes when a conversation produces something worth keeping. Sessions already started are not changed.",
        terms: "notes memory suggest offer",
    },
    {
        sectionId: "approvals",
        rowId: "approvals.offer-full-access",
        name: "Offer Full access",
        description: "Lists Full access in the approval menus and lets /permissions choose it. Kept in this window's storage.",
        terms: "permission approve allow full access",
    },
    {
        sectionId: "approvals",
        rowId: "approvals.default-mode",
        name: "Default approval mode",
        description: "The mode new sessions start in. Set it from a session: open the approval pill under the composer and choose Make this the default for new sessions.",
        terms: "permission approve deny allow mode",
    },
    {
        sectionId: "approvals",
        rowId: "approvals.standing-permissions",
        name: "Standing permissions",
        description: "What Yes, and always allow has allowed in every session, and what Yes, for this chat has allowed in one. Each session's approval pill lists them with a button to remove each.",
        terms: "permission approved always remove",
    },
    {
        sectionId: "providers",
        rowId: "providers.custom",
        name: "Custom provider",
        description: "Any OpenAI-compatible endpoint by its base URL.",
        terms: "provider endpoint base url custom",
    },
    {
        sectionId: "providers",
        rowId: "providers.fallback",
        name: "Fall back after failures",
        description: "Not available in this window.",
        terms: "model provider failure fallback",
    },
    {
        sectionId: "updates",
        rowId: "updates.new-versions",
        name: "New versions",
        description: "Ask shows a chip in the sidebar when a new version is ready. Automatic downloads it in the background; you still choose when to switch. Off never checks.",
        terms: "update upgrade version release download automatic ask off",
    },
    {
        sectionId: "updates",
        rowId: "updates.check-now",
        name: "Check now",
        description: "",
        terms: "update upgrade version release check new now",
    },
    ...FLAG_SPECS.map((spec): SettingsRowEntry => {
        const row = SHOW_ROWS.find((candidate) => candidate.key === spec.key);
        if (row === undefined) throw new Error(`No Show row for ${spec.key}.`);
        return {
            sectionId: "show",
            rowId: `show.${spec.key}`,
            name: row.name,
            description: row.description,
            terms: "show hide visible auto on off",
        };
    }),
    {
        sectionId: "data",
        rowId: "data.sessions",
        name: "Sessions",
        description: "Listed by the host this window is attached to",
        terms: "session count list",
    },
    {
        sectionId: "data",
        rowId: "data.desktop-folder",
        name: "Desktop folder",
        description: "",
        terms: "folder path home finder open desktop own",
    },
    {
        sectionId: "data",
        rowId: "data.appearance",
        name: "Appearance",
        description: "Theme, text size, code size, density and motion, kept in this desktop's browser storage",
        terms: "theme reset appearance",
    },
    {
        sectionId: "data",
        rowId: "data.layout",
        name: "Layout",
        description: "Pane sizes, what is shown and where, kept in machine/desktop/layout.json",
        terms: "layout pane reset",
    },
];

// Results list row hits first, then section hits, each in screen order.
export function searchSettings(query: string): readonly SettingsSearchHit[] {
    const words = query.trim();
    if (words === "") return [];
    const sectionById = new Map(SETTINGS_SECTIONS.map((section) => [section.id, section]));
    const hits: SettingsSearchHit[] = [];
    for (const row of SETTINGS_ROWS) {
        const section = sectionById.get(row.sectionId);
        if (section === undefined) continue;
        const haystack = `${row.name} ${row.description} ${row.terms} ${section.name}`;
        if (!matchesSettingsQuery(haystack, words)) continue;
        hits.push({ kind: "row", sectionId: row.sectionId, rowId: row.rowId, name: row.name });
    }
    for (const section of SETTINGS_SECTIONS) {
        if (matchesSettingsQuery(`${section.name} ${section.terms}`, words)) {
            hits.push({ kind: "section", sectionId: section.id, name: section.name });
        }
    }
    return hits;
}

// Moves the active result, wrapping at either end; -1 starts from the top going down and the bottom going up.
export function nextActiveIndex(current: number, count: number, direction: 1 | -1): number {
    if (count === 0) return -1;
    if (current < 0 || current >= count) return direction === 1 ? 0 : count - 1;
    return (current + direction + count) % count;
}
