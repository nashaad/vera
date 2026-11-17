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

export function shouldConfirmQuit(backgroundCommandCount: number): boolean {
    return backgroundCommandCount > 0;
}

export interface QuitBackgroundCommandSummary {
    readonly total: number;
    readonly current: number;
    readonly other: number;
    readonly conversations: number;
    readonly message: string;
}

export async function quitBackgroundCommandSummary(
    listSessionPage: ListSessionPage | undefined,
    currentAgentId: string | undefined,
    otherAgentId: string | undefined,
): Promise<QuitBackgroundCommandSummary> {
    const currentCount = currentAgentId === undefined
        ? Promise.resolve(0)
        : currentBackgroundCommandCount(listSessionPage, currentAgentId).catch(() => 0);
    const otherCount = otherAgentId === undefined || otherAgentId === currentAgentId
        ? Promise.resolve(0)
        : currentBackgroundCommandCount(listSessionPage, otherAgentId).catch(() => 0);
    const [current, other] = await Promise.all([currentCount, otherCount]);
    const total = current + other;
    const conversations = Number(current > 0) + Number(other > 0);
    const command = total === 1 ? "1 background command" : `${total} background commands`;
    const message = conversations > 1
        ? `${command} are running in ${conversations} conversations.`
        : current > 0
        ? `${command} ${total === 1 ? "is" : "are"} running in this conversation.`
        : `${command} ${total === 1 ? "is" : "are"} running in another conversation.`;
    return { total, current, other, conversations, message };
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
