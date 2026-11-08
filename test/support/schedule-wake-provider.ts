export interface ScheduleWakeProvider {
    readonly port: number;
    readonly requests: number;
    close(): void;
}

export function startScheduleWakeProvider(readInbox: boolean): ScheduleWakeProvider {
    let requests = 0;
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) {
                return new Response("not found", { status: 404 });
            }
            requests += 1;
            const toolCall = readInbox && requests === 1;
            const delta = toolCall
                ? {
                    role: "assistant",
                    tool_calls: [{
                        index: 0, id: "read-inbox", type: "function",
                        function: { name: "agent_inbox", arguments: "{}" },
                    }],
                }
                : { role: "assistant", content: "The crow saw the map." };
            const chunk = {
                id: "stub", object: "chat.completion.chunk", model: "stub-model",
                choices: [{ index: 0, delta, finish_reason: toolCall ? "tool_calls" : "stop" }],
            };
            return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
                headers: { "content-type": "text/event-stream" },
            });
        },
    });
    return {
        port: server.port!,
        get requests() { return requests; },
        close: () => { server.stop(true); },
    };
}
