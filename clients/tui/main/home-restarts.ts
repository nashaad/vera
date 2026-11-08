import type { RegisteredAgentSummary } from "../../../src/host/agent-registry.ts";
import type { RestartRecordWire } from "../../../src/host/protocol.ts";
import { isHomeClient } from "../home-client.ts";
import type { TuiRuntime } from "./runtime.ts";
import { homeStateWithRestarts, type HomeRestart } from "../home-screen.ts";
import { showStatusNotice } from "./notices.ts";

const UNTITLED_RESTART = "Untitled conversation";

/**
 * Only sessions the host still lists can be opened, so a record for a session
 * that is gone is not shown. The newest record of a session wins.
 */
export function homeRestartsFor(
    records: readonly RestartRecordWire[],
    agents: readonly RegisteredAgentSummary[],
): readonly HomeRestart[] {
    const newest = [...records].sort((left, right) =>
        Date.parse(right.at) - Date.parse(left.at)
    );
    const seen = new Set<string>();
    const restarts: HomeRestart[] = [];
    for (const record of newest) {
        if (seen.has(record.session_id)) continue;
        seen.add(record.session_id);
        const agent = agents.find((candidate) => candidate.id === record.session_id);
        if (agent === undefined) continue;
        restarts.push({
            sessionId: record.session_id,
            sessionPath: agent.session_path,
            title: agent.title ?? UNTITLED_RESTART,
            cause: record.cause,
        });
    }
    return restarts;
}

/** A host that cannot answer the request has no restart block, so any failure means none. */
export async function listHomeRestarts(
    rt: TuiRuntime,
    agents: readonly RegisteredAgentSummary[],
): Promise<readonly HomeRestart[]> {
    const restartRecords = rt.dependencies.restartRecords;
    if (restartRecords === undefined) return [];
    try {
        return homeRestartsFor(await restartRecords.list(), agents);
    } catch {
        return [];
    }
}

/** Startup reads only the restart block; the rows and their session flag keep their own source. */
export async function refreshHomeRestarts(rt: TuiRuntime): Promise<void> {
    if (rt.dependencies.listAgents === undefined) return;
    let agents: readonly RegisteredAgentSummary[];
    try {
        agents = await rt.dependencies.listAgents();
    } catch {
        return;
    }
    const restarts = await listHomeRestarts(rt, agents);
    if (!isHomeClient(rt.client)) return;
    rt.homeState = homeStateWithRestarts(rt.homeState, restarts);
    rt.homeView.update(rt.homeState);
    rt.renderer.requestRender();
}

export async function dismissHomeRestart(
    rt: TuiRuntime,
    sessionId: string,
): Promise<void> {
    const restartRecords = rt.dependencies.restartRecords;
    if (restartRecords === undefined) return;
    let dismissed = false;
    try {
        dismissed = (await restartRecords.dismiss(sessionId)).status === "dismissed";
    } catch {
        dismissed = false;
    }
    if (!dismissed) {
        showStatusNotice(rt, "Could not dismiss that session from the home list");
        return;
    }
    if (!isHomeClient(rt.client)) return;
    rt.homeState = homeStateWithRestarts(
        rt.homeState,
        rt.homeState.restarts.filter((restart) => restart.sessionId !== sessionId),
    );
    rt.homeView.update(rt.homeState);
    rt.renderer.requestRender();
}
