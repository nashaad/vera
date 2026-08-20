import type {
    VeraClientExtensionApi,
    VeraClientSession,
} from "../../../src/sdk/extensions.ts";
import type { VeraExtensionDisposer } from "../../../src/sdk/extensions.ts";
import {
    buildDashboardReport,
    type DashboardSort,
} from "./dashboard-report.ts";
import { renderDashboard, type DashboardViewState } from "./dashboard-view.ts";

/**
 * Sessions per request. Large enough that a normal profile arrives in one
 * round trip, small enough that the first page draws before the rest is read.
 */
const PAGE_SIZE = 200;
/** Pages read per refresh. Bounds a profile with thousands of sessions. */
const MAX_PAGES = 10;

const FACTS = ["usage", "context", "failure", "model"] as const;

interface DashboardState extends DashboardViewState {
    readonly sessions: readonly VeraClientSession[];
    readonly total?: number;
}

export function registerDashboard(vera: VeraClientExtensionApi): void {
    let state: DashboardState = {
        sessions: [],
        sort: "context",
        selected: 0,
        failuresOnly: false,
        loading: false,
    };
    let mounted: VeraExtensionDisposer | undefined;
    let open = false;
    let generation = 0;
    let requestRender: () => void = () => {};

    const report = () =>
        buildDashboardReport(state.sessions, {
            sort: state.sort,
            ...(state.total === undefined ? {} : { totalSessions: state.total }),
            partial: state.loading,
        });

    /**
     * Pages until the listing is exhausted, publishing after each page. The
     * first page draws immediately and the totals fill in behind it, which is
     * the only honest way to show an aggregate over a store too big to read in
     * one call.
     */
    const refresh = async (): Promise<void> => {
        const mine = ++generation;
        state = { ...state, sessions: [], loading: true };
        let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES; page += 1) {
            let result;
            try {
                result = await vera.sessions.list({
                    include: [...FACTS],
                    limit: PAGE_SIZE,
                    order: "recent",
                    ...(cursor === undefined ? {} : { cursor }),
                });
            } catch {
                break;
            }
            // A refresh started after this one owns the view now.
            if (mine !== generation) return;
            state = {
                ...state,
                sessions: [...state.sessions, ...result.sessions],
                ...(result.total === undefined ? {} : { total: result.total }),
            };
            requestRender();
            cursor = result.nextCursor;
            if (cursor === undefined) break;
        }
        if (mine !== generation) return;
        state = {
            ...state,
            loading: false,
            refreshedAt: new Date().toISOString().slice(11, 19),
        };
        requestRender();
    };

    const close = (): void => {
        open = false;
        generation += 1;
        void mounted?.();
        mounted = undefined;
    };

    const openDashboard = (): void => {
        if (open) return;
        open = true;
        mounted = vera.experimentalTui.mount({
            id: "dashboard",
            slot: "overlay",
            title: "Vera dashboard",
            modal: true,
            focusable: true,
            visible: () => open,
            render: (context) => {
                requestRender = () => context.requestRender();
                return renderDashboard(
                    report(),
                    state,
                    context.width,
                    context.height,
                );
            },
            onKey: (key) => {
                if (key.name === "escape") {
                    close();
                    return true;
                }
                const sort = sortForKey(key.name, key.shift);
                if (sort !== undefined) {
                    state = { ...state, sort, selected: 0 };
                    return true;
                }
                if (key.name === "f") {
                    state = { ...state, failuresOnly: !state.failuresOnly };
                    return true;
                }
                if (key.name === "r") {
                    void refresh();
                    return true;
                }
                if (key.name === "up" || key.name === "down") {
                    const rows = report().sessions.length;
                    const next = state.selected + (key.name === "down" ? 1 : -1);
                    state = {
                        ...state,
                        selected: Math.max(0, Math.min(rows - 1, next)),
                    };
                    return true;
                }
                if (key.name === "return") {
                    const row = report().sessions[state.selected];
                    if (row !== undefined) {
                        close();
                        void vera.agents.open({ agentId: row.id, pane: "main" });
                    }
                    return true;
                }
                return false;
            },
        });
        void refresh();
    };

    vera.commands.register({
        name: "dashboard",
        description: "Model activity across every session in this profile",
        usage: "/dashboard",
        run() {
            openDashboard();
            return { kind: "handled" };
        },
    });

    vera.onDispose(() => close());
}

function sortForKey(name: string, shift: boolean): DashboardSort | undefined {
    if (name === "c") return "context";
    if (name === "t") return "tokens";
    // `$` arrives as shift+4 on a US layout and as `$` where the host has
    // already resolved the character.
    if (name === "$" || (name === "4" && shift)) return "cost";
    return undefined;
}
