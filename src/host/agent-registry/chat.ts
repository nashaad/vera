import { cp, mkdir, realpath, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { chatFolderPath, isChatFolder } from "../../store/chat-folder.ts";
import type { AgentRegistry } from "../agent-registry.ts";

export const CHAT_AGENT_NAME = "chat";

export interface CreatedChatFolder {
    readonly cwd: string;
    readonly created: boolean;
}

export async function createChatFolder(sessionPath: string): Promise<CreatedChatFolder> {
    const folder = chatFolderPath(sessionPath);
    await mkdir(dirname(folder), { recursive: true, mode: 0o700 });
    let created = true;
    try {
        await mkdir(folder, { mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        created = false;
    }
    try {
        return { cwd: await realpath(folder), created };
    } catch (error) {
        if (created) await rm(folder, { recursive: true, force: true }).catch(() => {});
        throw error;
    }
}

// Only the session's own folder is recreated; any other missing cwd is left as it is.
export async function restoreChatFolder(sessionPath: string, cwd: string): Promise<void> {
    if (!isChatFolder(sessionPath, cwd)) return;
    try {
        await mkdir(cwd, { mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
}

// A session that cannot select `chat` stays on the default agent.
export async function selectChatAgent(reg: AgentRegistry, id: string): Promise<void> {
    try {
        await reg.selectAgentFor(id, CHAT_AGENT_NAME);
    } catch {
    }
}

// The copy is a real copy: the branch and its source are edited independently.
export async function copyChatFolder(source: string, destinationSessionPath: string): Promise<CreatedChatFolder> {
    const folder = chatFolderPath(destinationSessionPath);
    await mkdir(dirname(folder), { recursive: true, mode: 0o700 });
    await mkdir(folder, { mode: 0o700 });
    try {
        if (await folderExists(source)) {
            await cp(source, folder, { recursive: true, force: false, errorOnExist: true });
        }
        return { cwd: await realpath(folder), created: true };
    } catch (error) {
        await rm(folder, { recursive: true, force: true }).catch(() => {});
        throw error;
    }
}

async function folderExists(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
}
