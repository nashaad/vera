import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { downloadPublicFile } from "./web-fetch.ts";
import type { RegisteredTool, ToolOutput } from "./types.ts";

export function downloadDirectory(workspace: string): string {
    const downloads = join(homedir(), "Downloads");
    return existsSync(downloads) ? downloads : workspace;
}

export const webDownloadTool: RegisteredTool = {
    parallel: true,
    permissionOperation: "web.download",
    permissionInputs: [{ field: "url", kind: "url", verb: "read" }],
    definition: {
        name: "web_download",
        description: [
            "Save one public HTTP or HTTPS URL to a file in the user's",
            "Downloads folder and report where it landed. This is the only",
            "tool that downloads a file: use it whenever the user asks to",
            "download or save something, PDFs included, and reach for",
            "web_fetch only when the contents are what matters rather than",
            "the file. The contents are not read or",
            "returned. Local and private-network targets, oversized bodies,",
            "and slow requests are rejected.",
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                url: {
                    type: "string",
                    description: "The public HTTP or HTTPS URL to save.",
                },
            },
            required: ["url"],
            additionalProperties: false,
        },
    },
    async execute(input, context, signal): Promise<ToolOutput> {
        if (typeof input.url !== "string" || input.url.trim().length === 0) {
            throw new Error("web_download requires a non-empty url");
        }
        const { path, bytes } = await downloadPublicFile(
            input.url.trim(),
            downloadDirectory(context.workspace),
            signal,
        );
        return {
            kind: "output",
            output: `Saved ${formatBytes(bytes)} to ${path}`,
            isError: false,
        };
    },
};

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
