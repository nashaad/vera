import type { RegisteredTool, ToolOutput } from "./types.ts";

export const webFetchTool: RegisteredTool = {
    parallel: true,
    permissionOperation: "web.fetch",
    permissionInputs: [{ field: "url", kind: "url", verb: "read" }],
    definition: {
        name: "web_fetch",
        description: [
            "Read one public HTTP or HTTPS URL and return bounded readable",
            "text. Handles HTML, plain text, JSON, XML, and PDF, extracting a",
            "PDF's text automatically. This tool never writes a file: to save",
            "a URL to disk, including a PDF, call web_download instead. Use",
            "this instead of writing a script or invoking curl when the page",
            "contents are needed. Local and private-network targets, other",
            "binary responses, oversized bodies, and slow requests are",
            "rejected.",
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                url: {
                    type: "string",
                    description: "The public HTTP or HTTPS URL to read.",
                },
            },
            required: ["url"],
            additionalProperties: false,
        },
    },
    async execute(input, _context, signal): Promise<ToolOutput> {
        if (typeof input.url !== "string" || input.url.trim().length === 0) {
            throw new Error("web_fetch requires a non-empty url");
        }
        const { fetchReadablePage } = await import("./web-fetch.ts");
        return {
            kind: "output",
            output: await fetchReadablePage(input.url.trim(), signal),
            isError: false,
        };
    },
};

