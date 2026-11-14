import { FILE_COUNT_LIMIT, fileReferences } from "../../src/attachments/file-limits.ts";
import { prepareFiles, type FileLocation } from "../../src/attachments/files.ts";
import { decodeFilePath, FILE_PATH_PATTERN, filePathMentions } from "./file-paths.ts";
import type { TuiRuntime } from "./main/runtime.ts";

export async function tuiFileLocation(rt: TuiRuntime, agentId: string): Promise<FileLocation> {
    const page = rt.dependencies.listSessionPage;
    if (page !== undefined) {
        let cursor: string | undefined;
        for (let index = 0; index < 16; index += 1) {
            const result = await page({ limit: 128, order: "recent", ...(cursor === undefined ? {} : { cursor }) });
            const session = result.agents.find((agent) => agent.id === agentId);
            if (session !== undefined) return { workspace: session.workspace, chat: session.chat === true };
            if (result.nextCursor === undefined || result.nextCursor === cursor) break;
            cursor = result.nextCursor;
        }
    } else if (rt.dependencies.listAgents !== undefined) {
        const session = (await rt.dependencies.listAgents()).find((agent) => agent.id === agentId);
        if (session !== undefined) return { workspace: session.workspace, chat: session.chat === true };
    }
    throw new Error("The session folder is not available.");
}

export async function prepareTuiFileText(text: string, location: FileLocation, images: number): Promise<string> {
    const mentions = filePathMentions(text);
    if (mentions.length === 0) return text;
    if (mentions.length + images > FILE_COUNT_LIMIT) throw new Error("A message can have up to 8 files.");
    const paths = await prepareFiles(mentions.map((item) => item.path), location);
    const references = new Map(mentions.map((mention, index) => [mention.path, paths[index]!]));
    const onlyPath = mentions.length === 1 && text.trim() === mentions[0]!.text;
    const content = onlyPath ? text.replace(mentions[0]!.text, JSON.stringify(paths[0])) : text.replace(FILE_PATH_PATTERN, (match: string, raw: string) => {
        const path = references.get(decodeFilePath(raw));
        return path === undefined ? match : `${match.slice(0, match.length - raw.length)}${JSON.stringify(path)}`;
    });
    return `${content}\n\n${fileReferences(paths)}`;
}
