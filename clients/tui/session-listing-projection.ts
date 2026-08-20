import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import type {
    ListAgentsOptions,
    ListedAgentsPage,
} from "../../src/host/agent-list-client.ts";
import type {
    VeraClientSession,
    VeraClientSessionFacts,
    VeraClientSessionListRequest,
    VeraClientSessionPage,
} from "../../src/sdk/extensions.ts";

const MAX_LIMIT = 500;

/**
 * Projects host listing rows onto the plain shape extensions see.
 *
 * A projection rather than a pass-through: the host row names a session file
 * on disk and carries registry-shaped field names, neither of which an
 * extension may depend on. Only facts survive the crossing, and an absent
 * fact stays absent rather than becoming a zero.
 */
export async function listSessionsForExtension(
    listPage: (options: ListAgentsOptions) => Promise<ListedAgentsPage>,
    request: VeraClientSessionListRequest,
): Promise<VeraClientSessionPage> {
    const page = await listPage({
        ...(request.include === undefined ? {} : { include: request.include }),
        ...(request.limit === undefined
            ? {}
            : { limit: Math.max(1, Math.min(MAX_LIMIT, request.limit)) }),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        ...(request.order === undefined ? {} : { order: request.order }),
    });
    return {
        sessions: page.agents.map(projectSession),
        ...(page.nextCursor === undefined
            ? {}
            : { nextCursor: page.nextCursor }),
        ...(page.total === undefined ? {} : { total: page.total }),
    };
}

function projectSession(agent: RegisteredAgentSummary): VeraClientSession {
    const facts = projectFacts(agent);
    return {
        id: agent.id,
        ...(agent.title === undefined ? {} : { title: agent.title }),
        workspace: agent.workspace,
        kind: agent.kind,
        status: agent.status,
        live: agent.live,
        ...(agent.created_at === undefined
            ? {}
            : { createdAt: agent.created_at }),
        ...(agent.updated_at === undefined
            ? {}
            : { updatedAt: agent.updated_at }),
        ...(facts === undefined ? {} : { facts }),
    };
}

function projectFacts(
    agent: RegisteredAgentSummary,
): VeraClientSessionFacts | undefined {
    const facts = agent.facts;
    if (facts === undefined) return undefined;
    const context = facts.context;
    const projected: VeraClientSessionFacts = {
        ...(facts.usage === undefined
            ? {}
            : { usage: { rows: facts.usage.rows } }),
        ...(context === undefined ? {} : {
            context: {
                tokens: context.tokens,
                ...(context.capacity === undefined
                    ? {}
                    : { capacity: context.capacity }),
                estimated: context.estimated,
                ...(facts.contextMeasuredAt === undefined
                    ? {}
                    : { measuredAt: facts.contextMeasuredAt }),
            },
        }),
        ...(facts.model === undefined ? {} : { model: facts.model }),
        ...(facts.failure === undefined ? {} : {
            failure: {
                at: facts.failure.at,
                provider: facts.failure.provider,
                model: facts.failure.model,
                kind: facts.failure.kind,
                detail: facts.failure.detail,
                ...(facts.failure.statusCode === undefined
                    ? {}
                    : { statusCode: facts.failure.statusCode }),
            },
        }),
    };
    return Object.keys(projected).length === 0 ? undefined : projected;
}
