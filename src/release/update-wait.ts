import { listAgentPageThroughHost } from "../host/agent-list-client.ts";
import type { HostLockRecord } from "../host/lockfile.ts";
import { defaultReadLiveHost } from "./handoff.ts";
import { updateStopsHost } from "./install.ts";

// An update that finds sessions at work waits this long for them. Long enough for an ordinary turn
// or a build to finish; short enough that a forgotten session cannot hold an update for a day.
export const DEFAULT_BUSY_LIMIT_MS = 30 * 60_000;
const DEFAULT_POLL_MS = 3_000;
// Left at the end of a run for the shell swap, the host stop and the host start after the wait.
const SWITCH_RESERVE_MS = 3 * 60_000;
const AGENT_PAGE_SIZE = 100;
const MAX_AGENT_PAGES = 10;
const MAX_LISTED_SESSIONS = 20;

export interface BusySession {
    readonly id: string;
    readonly title: string;
}

export interface IdleWaitOptions {
    readonly readLiveHost?: () => Promise<HostLockRecord | undefined>;
    readonly listBusy?: (host: HostLockRecord) => Promise<readonly BusySession[]>;
    readonly limitMs?: number;
    readonly pollMs?: number;
    readonly now?: () => number;
    // Resolves after ms, or as soon as the signal aborts.
    readonly sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

export interface IdleWaitReport {
    readonly sessions: readonly BusySession[];
    readonly waitedMs: number;
    readonly limitMs: number;
}

export class UpdateBusyError extends Error {
    constructor(readonly sessions: readonly BusySession[], readonly limitMs: number) {
        super(
            `Vera is still busy after ${formatDuration(limitMs)}: ${sessions.map((session) => session.title).join(", ")}.`
            + " Nothing was changed. Run the update again when the sessions have finished.",
        );
        this.name = "UpdateBusyError";
    }
}

// Waits until no session is working or waiting on a reply, for at most the limit. Does nothing when the
// update will not stop the host. Throws UpdateBusyError at the limit and the signal's reason when it aborts.
export async function waitForIdleHost(options: {
    readonly buildId: string;
    readonly signal?: AbortSignal;
    // The run must end by this time (ms since the epoch); the wait shortens to end SWITCH_RESERVE_MS before it.
    readonly deadlineAt?: number;
    readonly onWaiting: (report: IdleWaitReport) => void;
    readonly idle?: IdleWaitOptions;
}): Promise<void> {
    const idle = options.idle ?? {};
    const live = await (idle.readLiveHost ?? defaultReadLiveHost)();
    if (!updateStopsHost(live, options.buildId)) return;
    const pollMs = idle.pollMs ?? DEFAULT_POLL_MS;
    const now = idle.now ?? Date.now;
    const configuredMs = idle.limitMs ?? busyLimitFromEnvironment() ?? DEFAULT_BUSY_LIMIT_MS;
    const limitMs = options.deadlineAt === undefined
        ? configuredMs
        : Math.max(0, Math.min(configuredMs, options.deadlineAt - SWITCH_RESERVE_MS - now()));
    const sleep = idle.sleep ?? abortableSleep;
    const listBusy = idle.listBusy ?? listBusySessions;
    const startedAt = now();
    for (;;) {
        options.signal?.throwIfAborted();
        const sessions = await listBusy(live).catch(() => [] as readonly BusySession[]);
        if (sessions.length === 0) return;
        const waitedMs = now() - startedAt;
        if (waitedMs >= limitMs) throw new UpdateBusyError(sessions, limitMs);
        options.onWaiting({ sessions, waitedMs, limitMs });
        await sleep(Math.min(pollMs, limitMs - waitedMs), options.signal);
    }
}

// Sessions the host would wait on before it stops. A session with queued input and no turn running is not listed.
export async function listBusySessions(host: HostLockRecord): Promise<readonly BusySession[]> {
    const busy: BusySession[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_AGENT_PAGES; page += 1) {
        const listed = await listAgentPageThroughHost(host.socket_path, {
            limit: AGENT_PAGE_SIZE,
            order: "recent",
            ...(cursor === undefined ? {} : { cursor }),
        });
        for (const agent of listed.agents) {
            if (agent.status !== "working" && agent.status !== "waiting") continue;
            busy.push({ id: agent.id, title: agent.title ?? agent.name ?? agent.id });
        }
        if (listed.nextCursor === undefined) break;
        cursor = listed.nextCursor;
    }
    return busy.slice(0, MAX_LISTED_SESSIONS);
}

export function formatDuration(ms: number): string {
    if (ms >= 60_000) {
        const minutes = Math.round(ms / 60_000);
        return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    }
    const seconds = Math.max(1, Math.round(ms / 1_000));
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

// Only the rehearsal shortens the limit; no setting exposes it.
function busyLimitFromEnvironment(): number | undefined {
    const value = Number(process.env.VERA_UPDATE_BUSY_LIMIT_MS);
    return Number.isFinite(value) && value > 0 ? value : undefined;
}

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve) => {
        if (signal?.aborted === true) {
            resolve();
            return;
        }
        const finish = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", finish);
            resolve();
        };
        const timer = setTimeout(finish, ms);
        signal?.addEventListener("abort", finish, { once: true });
    });
}
