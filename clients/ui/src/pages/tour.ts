import { OVERLAY_COMMANDS, type Overlay } from "../commands/overlay-ids.ts";
import { folderName } from "../protocol/sessionGroups.ts";
import type { SessionRow, SessionStatus } from "../protocol/sessions.ts";
import { SETTINGS_SECTIONS } from "./settings/sections.ts";
import type { Route, SessionRoute } from "./routes.ts";

export type TourStatus = Extract<SessionStatus, "working" | "waiting" | "completed" | "idle">;

export type TourAction =
    | { readonly kind: "route"; readonly route: Route }
    | { readonly kind: "command"; readonly commandId: string };

export interface TourCard {
    readonly id: string;
    readonly name: string;
    readonly desc: string;
    // Undefined when the card cannot open anything right now.
    readonly action: TourAction | undefined;
}

export interface TourGroup {
    readonly title: string;
    readonly cards: readonly TourCard[];
}

interface SessionCardSpec {
    readonly id: TourStatus;
    readonly name: string;
    readonly fallback: string;
}

const SESSION_SPECS: readonly SessionCardSpec[] = [
    { id: "working", name: "Working", fallback: "A turn running now" },
    { id: "waiting", name: "Waiting on you", fallback: "Stopped on an approval or a question" },
    { id: "completed", name: "Finished", fallback: "Its last turn finished" },
    { id: "idle", name: "Idle", fallback: "Nothing running" },
];

export const SHEET_DESCS: Readonly<Record<Overlay, string>> = {
    palette: "Every command, searchable",
    sessions: "Jump to any session",
    shortcuts: "Every key this window answers",
    agent: "Pick the agent a session runs as",
    themes: "Dark, light and high contrast",
    extensions: "What loaded and what failed",
    diagnostics: "Host facts, plus the open session's",
    doctor: "Checks on the home and the host",
    configure: "The files Vera reads its settings from",
    failures: "Where Vera records model failures",
    nudges: "Where standing nudges are managed",
};

// The newest row with the status. Timed rows beat untimed ones; ties and untimed rows keep the host's order.
export function newestWithStatus(rows: readonly SessionRow[], status: SessionStatus): SessionRow | undefined {
    let best: SessionRow | undefined;
    for (const row of rows) {
        if (row.status !== status) continue;
        if (best === undefined || isNewer(row, best)) best = row;
    }
    return best;
}

function isNewer(candidate: SessionRow, current: SessionRow): boolean {
    if (candidate.updatedAt === undefined) return false;
    if (current.updatedAt === undefined) return true;
    return candidate.updatedAt > current.updatedAt;
}

export function sessionRoute(row: SessionRow): SessionRoute {
    return {
        kind: "session",
        agentId: row.id,
        title: row.name,
        ...(row.workspace.length > 0 ? { workspace: row.workspace } : {}),
    };
}

// The desc of a card whose session was found, such as "Refactor the parser · vera".
export function foundSessionDesc(row: SessionRow): string {
    return `${row.name} · ${folderName(row.workspace)}`;
}

// `rows` is undefined until the host's first session listing arrives.
export function sessionCards(
    rows: readonly SessionRow[] | undefined,
    attached: boolean,
): readonly TourCard[] {
    return SESSION_SPECS.map((spec): TourCard => {
        if (!attached) {
            return { id: spec.id, name: spec.name, desc: "Vera is not connected", action: undefined };
        }
        if (rows === undefined) {
            return { id: spec.id, name: spec.name, desc: spec.fallback, action: undefined };
        }
        const row = newestWithStatus(rows, spec.id);
        if (row === undefined) {
            return { id: spec.id, name: spec.name, desc: "None right now", action: undefined };
        }
        return {
            id: spec.id,
            name: spec.name,
            desc: foundSessionDesc(row),
            action: { kind: "route", route: sessionRoute(row) },
        };
    });
}

export function pageCards(newestFolder: string | undefined): readonly TourCard[] {
    const workspace: TourCard = newestFolder === undefined
        ? { id: "workspace", name: "Workspace", desc: "No folder has a session", action: undefined }
        : {
            id: "workspace",
            name: "Workspace",
            desc: folderName(newestFolder),
            action: { kind: "route", route: { kind: "workspace", folder: newestFolder } },
        };
    return [
        page("new-chat", "New Chat", "Start a session in a folder", { kind: "home" }),
        page("work", "Work", "What is running and what needs you", { kind: "work" }),
        page("search", "Search", "Find a session by name or text", { kind: "search" }),
        workspace,
        page("devices", "Devices", "This machine and the clients attached to the host", { kind: "devices" }),
        page("customize", "Customize", "Skills, agents, extensions and instructions a folder loads", { kind: "customize" }),
        page("settings", "Settings", `${SETTINGS_SECTIONS.length} sections`, { kind: "settings" }),
        page("coverage", "Coverage", "What this window does at each step of a session", { kind: "coverage" }),
    ];
}

function page(id: string, name: string, desc: string, route: Route): TourCard {
    return { id, name, desc, action: { kind: "route", route } };
}

export function sheetCards(): readonly TourCard[] {
    return (Object.keys(OVERLAY_COMMANDS) as Overlay[]).map((overlay): TourCard => {
        const entry = OVERLAY_COMMANDS[overlay];
        return {
            id: `sheet-${overlay}`,
            name: entry.title,
            desc: SHEET_DESCS[overlay],
            action: { kind: "command", commandId: entry.id },
        };
    });
}

export function tourGroups(
    rows: readonly SessionRow[] | undefined,
    attached: boolean,
    newestFolder: string | undefined,
): readonly TourGroup[] {
    return [
        { title: "Sessions", cards: sessionCards(rows, attached) },
        { title: "Pages", cards: pageCards(newestFolder) },
        { title: "Sheets", cards: sheetCards() },
    ];
}
