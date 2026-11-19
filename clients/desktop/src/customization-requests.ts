import { connectHost, HostConnectionClosedError, type HostConnection } from "../../../src/host/connection.ts";
import { parseAgents, parseSkills, parseSources } from "../../ui/src/customize/wire.ts";
import type { FolderCustomizationsResult } from "../../ui/src/protocol/bridge.ts";

const READ_TIMEOUT_MS = 10_000;
const MAX_WARNINGS = 50;
const MAX_WARNING_CHARS = 2_000;

type Fields = Record<string, unknown>;

// A host that predates this request closes the connection without a reply.
export const RESTART_TO_READ = "Vera needs a restart to read what this folder loads.";

export async function readFolderCustomizations(
    socketPath: string | undefined,
    workspace: string | undefined,
): Promise<FolderCustomizationsResult> {
    if (socketPath === undefined) return { ok: false, reason: "The host is not running." };
    let connection: HostConnection | undefined;
    try {
        connection = await connectHost({ socketPath });
        await connection.send({ type: "folder_customizations", ...(workspace === undefined ? {} : { workspace }) });
        const reply = await connection.receiveWithin(READ_TIMEOUT_MS, "The host did not list customizations in time.");
        return parseFolderCustomizations(reply) ?? { ok: false, reason: RESTART_TO_READ };
    } catch (error) {
        if (error instanceof HostConnectionClosedError) return { ok: false, reason: RESTART_TO_READ };
        return { ok: false, reason: error instanceof Error && error.message.length > 0 ? error.message : "The host did not answer." };
    } finally {
        connection?.close();
    }
}

export function parseFolderCustomizations(reply: unknown): FolderCustomizationsResult | undefined {
    if (!isFields(reply) || reply.type !== "folder_customizations") return undefined;
    const { skills, agents, sources } = reply;
    if (!isFields(skills) || !isFields(agents) || !isFields(sources)) return undefined;
    if (typeof agents.starts_on !== "string" || agents.starts_on.length === 0) return undefined;
    if (!Array.isArray(skills.skills) || !Array.isArray(agents.agents) || !Array.isArray(sources.sources)) return undefined;
    return {
        ok: true,
        skills: parseSkills(skills.skills),
        startsOn: agents.starts_on,
        agents: parseAgents(agents.agents),
        sources: parseSources(sources.sources),
        warnings: warningsOf([skills.warnings, agents.notices, sources.warnings]),
    };
}

// The three lists repeat each other's warnings, so each text appears once, in the order first seen.
function warningsOf(lists: readonly unknown[]): readonly string[] {
    const seen = new Set<string>();
    for (const list of lists) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
            if (typeof entry === "string") seen.add(entry.slice(0, MAX_WARNING_CHARS));
            if (seen.size >= MAX_WARNINGS) return [...seen];
        }
    }
    return [...seen];
}

function isFields(value: unknown): value is Fields {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
