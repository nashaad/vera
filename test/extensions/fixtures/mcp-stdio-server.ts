// Minimal MCP stdio server used by the mcp extension tests: newline-delimited
// JSON-RPC with two tools, one prompt, and one readable resource. `die` exits
// the process mid-session so reconnect behavior can be exercised.

import { createInterface } from "node:readline";

const reader = createInterface({ input: process.stdin });

function send(message: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: unknown, result: unknown): void {
    send({ jsonrpc: "2.0", id, result });
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
            reply(request.id, {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {}, prompts: {}, resources: {} },
                serverInfo: { name: "fixture", version: "0.0.1" },
            });
            return;
        case "notifications/initialized":
        case "notifications/cancelled":
            return;
        case "tools/list":
            reply(request.id, {
                tools: [
                    {
                        name: "echo",
                        description: "Echo the given text back.",
                        inputSchema: {
                            type: "object",
                            properties: { text: { type: "string" } },
                            required: ["text"],
                        },
                        annotations: { readOnlyHint: true },
                    },
                    {
                        name: "die",
                        description: "Exit the server process.",
                        inputSchema: { type: "object", properties: {} },
                    },
                ],
            });
            return;
        case "tools/call": {
            const name = request.params?.name;
            const args = request.params?.arguments as
                | Record<string, unknown>
                | undefined;
            if (name === "echo") {
                reply(request.id, {
                    content: [{ type: "text", text: `echo: ${args?.text}` }],
                });
            } else if (name === "die") {
                process.exit(0);
            } else {
                reply(request.id, {
                    content: [{ type: "text", text: `unknown tool ${name}` }],
                    isError: true,
                });
            }
            return;
        }
        case "prompts/list":
            reply(request.id, {
                prompts: [{
                    name: "greet",
                    description: "Greet someone by name.",
                    arguments: [{ name: "name", required: true }],
                }],
            });
            return;
        case "prompts/get": {
            const args = request.params?.arguments as
                | Record<string, unknown>
                | undefined;
            reply(request.id, {
                messages: [{
                    role: "user",
                    content: {
                        type: "text",
                        text: `Hello, ${args?.name ?? "stranger"}!`,
                    },
                }],
            });
            return;
        }
        case "resources/read":
            reply(request.id, {
                contents: [{
                    uri: request.params?.uri,
                    text: `resource body for ${request.params?.uri}`,
                }],
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
