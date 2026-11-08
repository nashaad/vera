import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

const directory = process.env.MCP_RECONNECT_FIXTURE!;
const log = (event: string): void => appendFileSync(join(directory, "processes.log"), `${event} ${process.pid}\n`);
log("start");
process.on("exit", () => log("exit"));
process.on("SIGTERM", () => process.exit(0));
setTimeout(() => process.exit(0), Number(process.env.MCP_RECONNECT_LIFETIME_MS ?? "15000"));

const reader = createInterface({ input: process.stdin });
reader.on("close", () => process.exit(0));
reader.on("line", (line) => { void handle(JSON.parse(line)); });

async function handle(request: { id?: number; method: string; params?: { name?: string } }): Promise<void> {
    const reply = (result: unknown): void => {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    };
    if (request.method === "initialize") {
        if (existsSync(join(directory, "hold"))) {
            log("waiting");
            while (existsSync(join(directory, "hold"))) await Bun.sleep(10);
        }
        if (existsSync(join(directory, "fail"))) process.exit(1);
        reply({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "stub", version: "1" } });
    } else if (request.method === "tools/list") {
        reply({ tools: [
            { name: "echo", description: "Echo", inputSchema: { type: "object" } },
            { name: "slow", description: "Wait", inputSchema: { type: "object" } },
            { name: "large", description: "Return a large result", inputSchema: { type: "object" } },
        ] });
    } else if (request.method === "prompts/list") {
        reply({ prompts: [{ name: "greet", arguments: [] }] });
    } else if (request.method === "tools/call") {
        if (request.params?.name === "exit") process.exit(0);
        if (request.params?.name === "slow") { log("slow"); return; }
        if (request.params?.name === "large") {
            log("large");
            while (existsSync(join(directory, "hold-result"))) await Bun.sleep(10);
            reply({ content: [{ type: "text", text: "x".repeat(Number(process.env.MCP_RECONNECT_RESULT_BYTES ?? 10 * 1_024 * 1_024)) }] });
            return;
        }
        log("call");
        reply({ content: [{ type: "text", text: String(process.pid) }] });
    } else if (request.method === "notifications/cancelled") {
        log("cancel");
    } else if (request.method === "prompts/get") {
        log("prompt");
        reply({ messages: [{ content: { type: "text", text: String(process.pid) } }] });
    } else if (request.method === "resources/read") {
        reply({ contents: [{ text: String(process.pid) }] });
    }
}
