// A local chat-completions endpoint for a dev trial: it answers the first
// RETRY_FAUX_FAILURES requests with 503, then holds every later request open.
// That shows the retry line waiting for the next attempt, then in flight.
const port = Number(process.env.RETRY_FAUX_PORT ?? 8791);
const failures = Number(process.env.RETRY_FAUX_FAILURES ?? 2);
let requests = 0;

console.log(`retry faux provider: http://127.0.0.1:${port}/v1 (model retry-faux)`);
Bun.serve({
    port,
    idleTimeout: 0,
    fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname !== "/v1/chat/completions") {
            return new Response("not found", { status: 404 });
        }
        requests += 1;
        if (requests <= failures) {
            console.log(`request ${requests}: 503`);
            return Response.json({
                error: { message: "Faux backend overloaded", type: "server_error" },
            }, { status: 503 });
        }
        // No response bytes: the attempt stays in flight until the client cancels.
        console.log(`request ${requests}: holding the connection open`);
        return new Promise<Response>(() => undefined);
    },
});
