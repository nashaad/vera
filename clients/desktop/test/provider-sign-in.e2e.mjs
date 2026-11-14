import { createServer } from "node:http";
import { streamChunk, until } from "./faux-home.mjs";
import { startTrial } from "./trial.mjs";

const trial = startTrial();
const reply = "The crow is ready.";
const requests = [];
const provider = createServer((request, response) => {
    if (request.method === "GET" && request.url.endsWith("/models")) {
        if (request.headers.authorization !== "Bearer fake-key") { response.writeHead(401); response.end(); return; }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "crow-0" }] })); return;
    }
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
        const body = JSON.parse(raw);
        const user = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
        const text = JSON.stringify(user?.content ?? "");
        requests.push(text);
        const answer = text.match(/Reply with exactly: ([\w-]+)/)?.[1] ?? reply;
        const tool = text.match(/Call (\w+) with value (\w+)/);
        const call = tool === null ? undefined : { id: "call-probe", type: "function", function: { name: tool[1], arguments: JSON.stringify({ value: tool[2] }) } };
        const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
        if (body.stream === false) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ id: "reply", model: body.model, choices: [{ index: 0,
                message: call === undefined ? { role: "assistant", content: answer } : { role: "assistant", content: null, tool_calls: [call] },
                finish_reason: call === undefined ? "stop" : "tool_calls" }], usage })); return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(streamChunk(body.model, call === undefined ? { content: answer } : { tool_calls: [{ index: 0, ...call }] }));
        response.write(`data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: call === undefined ? "stop" : "tool_calls" }], usage })}\n\n`);
        response.end("data: [DONE]\n\n");
    });
});

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const app = await trial.launch();
    const page = await app.firstWindow();
    await trial.waitForHost();
    const wizard = page.getByRole("dialog", { name: "Connect a provider" });
    await wizard.waitFor({ timeout: 45_000 });
    await wizard.getByRole("button", { name: "Add a custom provider" }).click();
    await wizard.getByLabel("Provider name").fill("faux-0");
    await wizard.getByLabel("Endpoint").fill(`http://127.0.0.1:${provider.address().port}/v1`);
    await wizard.getByLabel("API key").fill("fake-key");
    await wizard.getByRole("button", { name: "Connect", exact: true }).click();
    await wizard.getByLabel("Model").waitFor({ timeout: 45_000 });
    await wizard.getByRole("button", { name: "Use model" }).click();
    await wizard.waitFor({ state: "detached", timeout: 60_000 });
    const input = page.locator(".composer-input");
    await input.fill("Hello crow");
    await input.press("Enter");
    await page.getByText(reply, { exact: true }).waitFor({ timeout: 45_000 });
    await until("the first message", () => requests.some((text) => text.includes("Hello crow")));
    console.log("Provider sign-in and first chat passed.");
} finally {
    await trial.cleanup();
    await new Promise((resolve) => provider.close(resolve));
}
