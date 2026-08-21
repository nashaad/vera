const response = [
    `data: ${JSON.stringify({
        model: "faux-model",
        choices: [{
            index: 0,
            delta: { content: "container faux passed" },
            finish_reason: "stop",
        }],
        usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
        },
    })}`,
    "",
    "data: [DONE]",
    "",
].join("\n");

Bun.serve({
    port: 8790,
    fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method !== "POST" || path !== "/v1/chat/completions") {
            return new Response("not found", { status: 404 });
        }
        return new Response(response, {
            headers: { "content-type": "text/event-stream" },
        });
    },
});

await new Promise(() => {});
