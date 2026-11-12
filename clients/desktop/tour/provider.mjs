// Scripted chat-completions provider for the desktop tour; each reply depends only on the last user message.
import { createServer } from "node:http";

const MOTTO = "Shiny buttons gleam in the crow's nest,\nI hoard every one, arr, and none of them are yours!";
const MODEL = "crow-0";
const WORD_GAP_MS = 60;
// Call IDs must be unique across the whole conversation, not per reply.
let callCount = 0;

export function startTourProvider() {
    const server = createServer((request, response) => {
        if (request.method === "GET" && request.url.endsWith("/models")) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ data: [{ id: MODEL }] }));
            return;
        }
        let raw = "";
        request.on("data", (part) => { raw += part; });
        request.on("end", () => handle(JSON.parse(raw), response));
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            resolve({
                port,
                close: () => new Promise((done) => {
                    server.closeAllConnections();
                    server.close(done);
                }),
            });
        });
    });
}

function handle(body, response) {
    if (body.stream === false) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
            id: "reply",
            model: body.model,
            choices: [{ index: 0, message: { role: "assistant", content: "Crow" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        }));
        return;
    }
    const messages = body.messages ?? [];
    const lastUser = messages.findLastIndex((message) => message.role === "user");
    const text = textOf(messages[lastUser]);
    const results = messages.slice(lastUser + 1).filter((message) => message.role === "tool").length;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (text.includes("motto")) {
        streamWords(body.model, response, MOTTO);
        return;
    }
    if (text.includes("treasure.md")) {
        const steps = [
            { name: "read", input: { path: "treasure.md" } },
            { name: "edit", input: { path: "treasure.md", edits: [{ old_string: "- Silver spoons: 4", new_string: "- Silver spoons: 4\n- Shiny buttons: 3" }] } },
            { name: "bash", input: { command: "mkdir -p map-room" } },
        ];
        if (results < steps.length) {
            respondWithCall(body.model, response, steps[results]);
        } else {
            respondWithText(body.model, response, "Done. I added the shiny buttons line to treasure.md and made map-room beside it.");
        }
        return;
    }
    if (text.includes("lookout")) {
        if (results === 0) {
            respondWithCall(body.model, response, { name: "bash", input: { command: "touch ../lookout.txt" } });
        } else {
            respondWithText(body.model, response, "Done. The lookout is posted.");
        }
        return;
    }
    respondWithText(body.model, response, "Aye, the crow is listening. Ask for a motto, a file edit, or a lookout.");
}

function textOf(message) {
    if (typeof message?.content === "string") return message.content;
    return JSON.stringify(message?.content ?? "");
}

function respondWithText(model, response, text) {
    response.write(chunk(model, { role: "assistant", content: text }, "stop"));
    response.end("data: [DONE]\n\n");
}

function respondWithCall(model, response, step) {
    callCount += 1;
    const call = { index: 0, id: `call-${callCount}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.input) } };
    response.write(chunk(model, { role: "assistant", tool_calls: [call] }, "tool_calls"));
    response.end("data: [DONE]\n\n");
}

function streamWords(model, response, text) {
    const words = text.split(/(?<=\s)/);
    let next = 0;
    const timer = setInterval(() => {
        if (response.destroyed) {
            clearInterval(timer);
            return;
        }
        if (next < words.length) {
            const delta = next === 0 ? { role: "assistant", content: words[next] } : { content: words[next] };
            response.write(chunk(model, delta, null));
            next += 1;
            return;
        }
        clearInterval(timer);
        response.write(chunk(model, {}, "stop"));
        response.end("data: [DONE]\n\n");
    }, WORD_GAP_MS);
    response.on("close", () => clearInterval(timer));
}

function chunk(model, delta, finish) {
    const choice = { index: 0, delta, finish_reason: finish };
    return `data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", model, choices: [choice] })}\n\n`;
}
