import { statSync } from "node:fs";
import type { AgentRegistry, RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import { entryIsLive, importedSessionSummary } from "../../src/host/agent-registry/support.ts";
import { firstPromptEntry, listedTitle } from "../../src/host/agent-registry/session-title.ts";
import { sessionChangedFiles } from "../../src/store/preimage-stash.ts";
import type { WorkAgentFacts } from "../../src/host/work-index.ts";

export function list(reg: AgentRegistry): RegisteredAgentSummary[] {
        const sizeOnDisk = (path: string): number | undefined => {
            try {
                return statSync(path).size;
            } catch {
                return undefined;
            }
        };

        return [...reg.agents.values()]
            .filter((entry) => !entry.ephemeral && !entry.pendingPublication)
            .map((entry) => {
                const activeEntries = entry.store.activeEntries();
                const firstUserEntry = firstPromptEntry(activeEntries);
                const title = listedTitle(entry.store.name(), firstUserEntry);
                const size = sizeOnDisk(entry.store.path);
                return {
                    id: entry.agent.id,
                    name: entry.identity?.name,
                    workspace: entry.agent.workspace,
                    session_path: entry.store.path,
                    kind: entry.kind,
                    status: entry.failure !== undefined
                        ? "failed" as const
                        : entry.agent.closed
                            ? "closed" as const
                            : entry.completed && entry.agent.status === "idle"
                                ? "completed" as const
                                : entry.agent.status,
                    live: entryIsLive(entry),
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
                    has_user_content: firstUserEntry !== undefined,
                    ...(entry.store.header.origin === undefined
                        ? {}
                        : { forked_from: entry.store.header.origin.sessionId }),
                    ...importedSessionSummary(entry.store.header),
                    ...(entry.parentId === undefined
                        ? {}
                        : { parent_id: entry.parentId }),
                    updated_at: entry.store.agentFailure()?.timestamp
                        ?? activeEntries.at(-1)?.timestamp
                        ?? entry.store.header.timestamp,
                    ...(size === undefined ? {} : { size_bytes: size }),
                };
            })
            .sort((left, right) => left.id.localeCompare(right.id));
    }

export function workFacts(reg: AgentRegistry): readonly WorkAgentFacts[] {
        const unreadResults = new Set<string>();
        for (const entry of reg.agents.values()) {
            for (const delivery of entry.store.pendingDeliveries()) {
                if (delivery.kind !== "attention") {
                    unreadResults.add(delivery.sourceAgentId);
                }
            }
        }
        return list(reg).flatMap((summary) => {
            const entry = reg.agents.get(summary.id);
            if (entry === undefined) return [];
            const failure = entry.store.agentFailure()?.detail;
            const activeTool = entry.agent.activeTool;
            const changed = summary.status === "working"
                    || summary.status === "waiting"
                ? 0
                : sessionChangedFiles(summary.id).length;
            return [{
                id: summary.id,
                session_path: summary.session_path,
                title: summary.title ?? summary.name ?? summary.id,
                workspace: summary.workspace,
                kind: summary.kind,
                status: summary.status,
                live: summary.live,
                updated_at: summary.updated_at
                    ?? entry.store.header.timestamp,
                ...(summary.parent_id === undefined
                    ? {}
                    : { parent_id: summary.parent_id }),
                ...(entry.agent.pendingRequests[0] === undefined
                    ? {}
                    : { pending_request: entry.agent.pendingRequests[0] }),
                ...(activeTool === undefined ? {} : { active_tool: activeTool }),
                ...(unreadResults.has(summary.id) ? { unread_result: true } : {}),
                ...(changed === 0 ? {} : { changed_files: changed }),
                ...(failure === undefined ? {} : { failure }),
            }];
        });
    }

