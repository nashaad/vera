import type { RegisteredAgentSummary } from "./agent-registry.ts";
import type { SessionFactName } from "../store/session-facts.ts";
import { connectHost } from "./connection.ts";

export interface ListAgentsOptions {
    readonly include?: readonly SessionFactName[];
    readonly limit?: number;
    readonly cursor?: string;
    readonly order?: "id" | "recent";
}

export interface ListedAgentsPage {
    readonly agents: readonly RegisteredAgentSummary[];
    readonly nextCursor?: string;
    readonly total?: number;
}

export async function listAgentsThroughHost(
    socketPath: string,
    responseTimeoutMs = 2_000,
): Promise<RegisteredAgentSummary[]> {
    return [...(await listAgentPageThroughHost(socketPath, {}, responseTimeoutMs))
        .agents];
}

export async function listAgentPageThroughHost(
    socketPath: string,
    options: ListAgentsOptions = {},
    responseTimeoutMs = 2_000,
): Promise<ListedAgentsPage> {
    const connection = await connectHost({ socketPath });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        await connection.send({
            type: "list_agents",
            ...(options.include === undefined ? {} : { include: options.include }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.order === undefined ? {} : { order: options.order }),
        });
        const response = asRecord(await Promise.race([
            connection.receive(),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => {
                    reject(new Error("Host agent list deadline exceeded"));
                }, responseTimeoutMs);
            }),
        ]));
        if (
            response?.type !== "agent_list"
            || !Array.isArray(response.agents)
            || !response.agents.every(isAgentSummary)
        ) {
            throw new Error("Host returned an invalid agent list");
        }
        return {
            agents: response.agents,
            ...(typeof response.next_cursor === "string"
                    && response.next_cursor.length > 0
                ? { nextCursor: response.next_cursor }
                : {}),
            ...(typeof response.total === "number"
                    && Number.isSafeInteger(response.total)
                ? { total: response.total }
                : {}),
        };
    } finally {
        clearTimeout(timeout);
        connection.close();
    }
}

function isAgentSummary(value: unknown): value is RegisteredAgentSummary {
    const agent = asRecord(value);
    return typeof agent?.id === "string"
        && agent.id.length > 0
        && (agent.name === undefined || typeof agent.name === "string")
        && typeof agent.workspace === "string"
        && agent.workspace.length > 0
        && typeof agent.session_path === "string"
        && agent.session_path.length > 0
        && (agent.kind === "interactive" || agent.kind === "background")
        && (
            agent.status === "idle"
            || agent.status === "working"
            || agent.status === "waiting"
            || agent.status === "completed"
            || agent.status === "closed"
            || agent.status === "failed"
        )
        && typeof agent.live === "boolean"
        && isOptionalPid(agent.worker_pid)
        && isOptionalPid(agent.supervisor_pid)
        && (agent.title === undefined || typeof agent.title === "string")
        && (agent.has_user_content === undefined
            || typeof agent.has_user_content === "boolean")
        && (
            agent.forked_from === undefined
            || (
                typeof agent.forked_from === "string"
                && agent.forked_from.length > 0
            )
        )
        && (
            agent.parent_id === undefined
            || (
                typeof agent.parent_id === "string"
                && agent.parent_id.length > 0
            )
        )
        && (
            agent.size_bytes === undefined
            || (
                typeof agent.size_bytes === "number"
                && Number.isSafeInteger(agent.size_bytes)
                && agent.size_bytes >= 0
            )
        )
        && isOptionalTimestamp(agent.created_at)
        && isOptionalTimestamp(agent.updated_at)
        // Facts are opaque to the listing contract: an older client that never asked for them must not reject a row that carries them.
        && (agent.facts === undefined || asRecord(agent.facts) !== undefined);
}

function isOptionalPid(value: unknown): boolean {
    return value === undefined
        || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

function isOptionalTimestamp(value: unknown): boolean {
    return value === undefined
        || (typeof value === "string" && !Number.isNaN(Date.parse(value)));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
