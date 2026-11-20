import type { ListedAgentsPage } from "../../../src/host/agent-list-client.ts";
import type { TuiRuntime } from "./runtime.ts";

/** A page of the session list. The rows are required; the page total arrives only from a host that reports it. */
export async function listAgentPageForTui(
    rt: TuiRuntime,
): Promise<ListedAgentsPage> {
    if (rt.dependencies.listAgentsPage !== undefined) {
        return await rt.dependencies.listAgentsPage();
    }
    if (rt.dependencies.listAgents === undefined) {
        throw new Error("This host does not list sessions");
    }
    return { agents: await rt.dependencies.listAgents() };
}
