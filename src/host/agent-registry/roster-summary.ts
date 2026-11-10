import { statSync } from "node:fs";
import { entryIsLive, importedSessionSummary, type RegisteredAgentEntry, type RegisteredAgentSummary } from "./support.ts";
import { storeListedTitle } from "./session-title.ts";

interface CachedSummary {
    readonly inputs: readonly unknown[];
    readonly summary: RegisteredAgentSummary;
}

const summaries = new WeakMap<RegisteredAgentEntry, CachedSummary>();

export function sessionSummary(entry: RegisteredAgentEntry): RegisteredAgentSummary {
    let size: number | undefined;
    try {
        size = statSync(entry.store.path).size;
    } catch {
        size = undefined;
    }
    const status = entry.failure !== undefined
        ? "failed" as const
        : entry.agent.closed
            ? "closed" as const
            : entry.completed && entry.agent.status === "idle"
                ? "completed" as const
                : entry.agent.status;
    const live = entryIsLive(entry);
    const inputs = [
        entry.store, entry.store.appendedLineCount(), entry.store.name(),
        entry.store.agentFailure()?.timestamp, size, status, live, entry.identity?.name,
        entry.kind, entry.parentId, entry.worker?.pid, entry.worker?.supervisor?.pid,
    ];
    const cached = summaries.get(entry);
    if (cached !== undefined
        && inputs.every((value, index) => value === cached.inputs[index])) {
        return cached.summary;
    }
    const firstUser = entry.store.firstUserFacts();
    const title = storeListedTitle(entry.store);
    const summary: RegisteredAgentSummary = {
        id: entry.agent.id,
        name: entry.identity?.name,
        workspace: entry.agent.workspace,
        session_path: entry.store.path,
        kind: entry.kind,
        status,
        live,
        ...(entry.worker === undefined
            ? {}
            : {
                worker_pid: entry.worker.pid,
                ...(entry.worker.supervisor?.pid === null
                        || entry.worker.supervisor?.pid === undefined
                    ? {}
                    : { supervisor_pid: entry.worker.supervisor.pid }),
            }),
        ...(title === undefined ? {} : { title }),
        has_user_content: firstUser !== undefined,
        ...(entry.store.header.origin === undefined
            ? {}
            : { forked_from: entry.store.header.origin.sessionId }),
        ...importedSessionSummary(entry.store.header),
        ...(entry.parentId === undefined
            ? {}
            : { parent_id: entry.parentId }),
        updated_at: entry.store.agentFailure()?.timestamp
            ?? entry.store.latestMessageTimestamp()
            ?? entry.store.header.timestamp,
        ...(size === undefined ? {} : { size_bytes: size }),
    };
    summaries.set(entry, { inputs, summary });
    return summary;
}
