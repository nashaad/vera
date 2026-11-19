import { connectHost, type HostConnection } from "../../../src/host/connection.ts";
import { parseAgents } from "../../ui/src/customize/wire.ts";
import type { NewSessionAgentsResult } from "../../ui/src/protocol/bridge.ts";

const READ_TIMEOUT_MS = 10_000;
const MAX_NOTICES = 50;
const MAX_NOTICE_CHARS = 2_000;

type Fields = Record<string, unknown>;

// A host that predates this request closes the connection without a reply, so any failure here reads as "not offered".
export async function readNewSessionAgents(
    socketPath: string | undefined,
    workspace: string | undefined,
): Promise<NewSessionAgentsResult> {
    if (socketPath === undefined) return { ok: false, reason: "The host is not running." };
    let connection: HostConnection | undefined;
    try {
        connection = await connectHost({ socketPath });
        await connection.send({ type: "new_session_agents", ...(workspace === undefined ? {} : { workspace }) });
        const reply = await connection.receiveWithin(READ_TIMEOUT_MS, "The host did not list agents in time.");
        return parseNewSessionAgents(reply) ?? { ok: false, reason: "The host sent agents this window could not read." };
    } catch (error) {
        return { ok: false, reason: error instanceof Error && error.message.length > 0 ? error.message : "The host did not answer." };
    } finally {
        connection?.close();
    }
}

export function parseNewSessionAgents(reply: unknown): NewSessionAgentsResult | undefined {
    if (!isFields(reply) || reply.type !== "new_session_agents") return undefined;
    if (typeof reply.starts_on !== "string" || reply.starts_on.length === 0 || !Array.isArray(reply.agents)) return undefined;
    const notices = Array.isArray(reply.notices)
        ? reply.notices
            .filter((entry): entry is string => typeof entry === "string")
            .slice(0, MAX_NOTICES)
            .map((entry) => entry.slice(0, MAX_NOTICE_CHARS))
        : [];
    return { ok: true, startsOn: reply.starts_on, agents: parseAgents(reply.agents), notices };
}

function isFields(value: unknown): value is Fields {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
