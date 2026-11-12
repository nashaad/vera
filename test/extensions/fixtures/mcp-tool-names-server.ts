// Minimal MCP stdio server with one lowercase and one uppercase tool name, and
// optionally one tool whose schema the registry refuses.
// Used by mcp.test.ts for bridged tool names and a per-tool skip.

import { createInterface } from "node:readline";

const reader = createInterface({ input: process.stdin });

function send(message: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

reader.on("line", (line) => {
    if (line.trim().length === 0) {
        return;
    }
    const request = JSON.parse(line) as {
        id?: unknown;
        method: string;
        params?: Record<string, unknown>;
    };
    switch (request.method) {
        case "initialize":
            send({
                jsonrpc: "2.0",
                id: request.id,
                result: {
                    protocolVersion: "2025-06-18",
                    capabilities: { tools: {} },
                    serverInfo: { name: "parrot", version: "0.0.1" },
                },
            });
            return;
        case "notifications/initialized":
        case "notifications/cancelled":
            return;
        case "tools/list": {
            const tools: Record<string, unknown>[] = [
                {
                    name: "perch",
                    description: "Sit on a perch.",
                    inputSchema: { type: "object", properties: {} },
                },
                {
                    name: "GetParrot",
                    description: "Fetch the parrot.",
                    inputSchema: { type: "object", properties: {} },
                },
            ];
            if (process.env.MCP_FIXTURE_BAD_SCHEMA === "1") {
                tools.push({
                    name: "broken",
                    description: "Declares a schema the registry refuses.",
                    inputSchema: { type: "array" },
                });
            }
            send({
                jsonrpc: "2.0",
                id: request.id,
                result: { tools },
            });
            return;
        }
        case "tools/call":
            send({
                jsonrpc: "2.0",
                id: request.id,
                result: { content: [{ type: "text", text: "pieces of eight" }] },
            });
            return;
        default:
            send({
                jsonrpc: "2.0",
                id: request.id,
                error: { code: -32601, message: "Method not found" },
            });
    }
});
