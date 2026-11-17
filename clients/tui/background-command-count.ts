import type {
    ListAgentsOptions,
    ListedAgentsPage,
} from "../../src/host/agent-list-client.ts";

export const BACKGROUND_COMMAND_PAGE_SIZE = 50;
const BACKGROUND_COMMAND_MAX_PAGES = 100;

export type ListSessionPage = (
    options: ListAgentsOptions,
) => Promise<ListedAgentsPage>;

export async function currentBackgroundCommandCount(
    listSessionPage: ListSessionPage | undefined,
    agentId: string | undefined,
): Promise<number> {
    if (listSessionPage === undefined) {
        throw new Error("Session listing is unavailable");
    }
    if (agentId === undefined) {
        throw new Error("Current conversation ID is unavailable");
    }

    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < BACKGROUND_COMMAND_MAX_PAGES; pageIndex++) {
        const page = await listSessionPage({
            limit: BACKGROUND_COMMAND_PAGE_SIZE,
            order: "recent",
            ...(cursor === undefined ? {} : { cursor }),
        });
        if ((page.unavailableWorkers?.length ?? 0) > 0) {
            throw new Error("A pool worker is unavailable, so the conversation count cannot be verified");
        }
        const agent = page.agents.find((candidate) => candidate.id === agentId);
        if (agent !== undefined) return agent.background_commands ?? 0;
        if (page.nextCursor === undefined || page.nextCursor === cursor) {
            throw new Error("Current conversation is missing from the host session list");
        }
        cursor = page.nextCursor;
    }

    throw new Error("Current conversation was not found within 5,000 sessions");
}

export function stopAndCloseDescription(count: number): string {
    if (count <= 0) return "stop this conversation and its running turn";
    const commands = count === 1 ? "1 background command" : `${count} background commands`;
    return `stop this conversation and its ${commands}`;
}

export function stopAndSwitchDescription(count: number): string {
    const commands = count === 1 ? "1 background command" : `${count} background commands`;
    return `stop this conversation and its ${commands}, then open the one you picked`;
}

export function stopAndCreateDescription(count: number): string {
    const commands = count === 1 ? "1 background command" : `${count} background commands`;
    return `stop it and its ${commands}, then start a new one`;
}
