import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { startTrial } from "./trial.mjs";

const key = "fake-deepseek-key";
const modelRequests = [];
const chats = [];
const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
        const path = new URL(request.url, "http://127.0.0.1").pathname.replace(/^\/v1/, "");
        if (request.method === "GET" && path === "/models") {
            const authorized = request.headers.authorization === `Bearer ${key}`;
            modelRequests.push(authorized);
            response.writeHead(authorized ? 200 : 401, { "content-type": "application/json" });
            response.end(JSON.stringify(authorized
                ? { object: "list", data: [{ id: "deepseek-chat", object: "model" }, { id: "deepseek-reasoner", object: "model" }] }
                : { error: { message: "Authentication Fails, Your api key is invalid" } }));
            return;
        }
        if (request.headers.authorization !== `Bearer ${key}`) {
            response.writeHead(401);
            response.end();
            return;
        }
        if (request.method === "POST" && path === "/chat/completions") {
            const parsed = JSON.parse(body);
            chats.push(parsed);
            const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
            const prompt = JSON.stringify(parsed.messages ?? []);
            const toolProbe = (parsed.tools ?? []).some((tool) => tool.function?.name === "admission_probe");
            const maxProbe = !toolProbe && parsed.reasoning_effort === "max" && prompt.includes("vera-admission-ok");
            const text = prompt.includes("vera-admission-ok") ? "vera-admission-ok" : "pong";
            const toolCall = { index: 0, id: "call_1", type: "function", function: { name: "admission_probe", arguments: "{\"value\":\"ok\"}" } };
            if (parsed.stream) {
                response.writeHead(200, { "content-type": "text/event-stream" });
                const chunk = (delta, finish, extra = {}) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
                const first = toolProbe ? chunk({ role: "assistant", tool_calls: [toolCall] }, null)
                    : maxProbe ? chunk({ role: "assistant", reasoning_content: "Thinking" }, null)
                    : chunk({ role: "assistant", content: text }, null);
                response.end(first + chunk({}, toolProbe ? "tool_calls" : maxProbe ? "length" : "stop", { usage }) + "data: [DONE]\n\n");
            } else {
                response.writeHead(200, { "content-type": "application/json" });
                const message = toolProbe ? { role: "assistant", content: null, tool_calls: [toolCall] }
                    : maxProbe ? { role: "assistant", reasoning_content: "Thinking" }
                    : { role: "assistant", content: text };
                response.end(JSON.stringify({ id: "c1", object: "chat.completion", created: 1, model: parsed.model, choices: [{ index: 0, message, finish_reason: toolProbe ? "tool_calls" : maxProbe ? "length" : "stop" }], usage }));
            }
            return;
        }
        response.writeHead(404);
        response.end();
    });
});

async function until(description, check, timeout = 45_000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${description}`);
}

const trial = startTrial();
let listening = false;
try {
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    listening = true;
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    mkdirSync(join(trial.home, "machine"), { recursive: true });
    writeFileSync(join(trial.home, "machine", "env"), "", { mode: 0o600 });
    const reserved = new Set(["HOME", "VERA_HOME", "VERA_DEV_INSTANCE", "VERA_DESKTOP_DEV_CLI", "VERA_DESKTOP_BUN"]);
    const env = Object.fromEntries(Object.keys(process.env).filter((name) => !reserved.has(name)).map((name) => [name, undefined]));
    env.PATH = process.env.PATH;
    env.TMPDIR = process.env.TMPDIR;
    const app = await trial.launch({ env });
    const inheritedKeys = await app.evaluate(() => Object.keys(process.env).filter((name) => name.endsWith("_API_KEY")));
    assert.deepEqual(inheritedKeys, []);
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 820 });
    const wizard = page.locator(".provider-wizard-sheet");
    await wizard.waitFor({ timeout: 45_000 });
    await wizard.getByRole("button", { name: /DeepSeek/ }).click();
    await wizard.getByLabel("DeepSeek API key").fill("wrong-key");
    await wizard.locator(".provider-wizard-endpoint summary").click();
    await wizard.getByLabel("Endpoint").fill(endpoint);
    await wizard.getByRole("button", { name: "Continue", exact: true }).click();
    const error = wizard.locator(".provider-wizard-error");
    await error.waitFor({ timeout: 30_000 });
    assert.match(await error.innerText(), /Catalog request returned HTTP 401:.*Authentication Fails/);
    assert.deepEqual(modelRequests, [false]);

    await wizard.getByLabel("DeepSeek API key").fill(key);
    await wizard.getByRole("button", { name: "Continue", exact: true }).click();
    await wizard.getByRole("status").getByText("DeepSeek key works", { exact: true }).waitFor({ timeout: 30_000 });
    const radios = wizard.getByRole("radio");
    assert.equal(await radios.count(), 2);
    const pro = wizard.getByRole("radio", { name: /DeepSeek V4 Pro/ });
    const flash = wizard.getByRole("radio", { name: /DeepSeek V4\.1 Flash 1017/ });
    assert.equal(await pro.count(), 1);
    assert.equal(await flash.count(), 1);
    assert.equal(await pro.isChecked(), false);
    assert.equal(await flash.isChecked(), true);
    assert.equal(await error.count(), 0);
    assert.deepEqual(modelRequests, [false, true]);

    await wizard.getByRole("button", { name: "Check and use", exact: true }).click();
    await wizard.waitFor({ state: "detached", timeout: 45_000 });
    assert.ok(chats.some((body) => JSON.stringify(body.messages ?? []).includes("vera-admission-ok")));
    assert.ok(chats.some((body) => body.reasoning_effort === "max" && JSON.stringify(body.messages ?? []).includes("vera-admission-ok")));
    assert.ok(chats.some((body) => (body.tools ?? []).some((tool) => tool.function?.name === "admission_probe")));
    const model = page.locator(".model-pill .pill-label");
    const pill = page.locator(".effort-pill");
    await until("DeepSeek V4.1 Flash 1017 and High on New Chat", async () =>
        await model.count() === 1 && (await model.innerText()).trim() === "DeepSeek V4.1 Flash 1017"
        && await pill.count() === 1 && (await pill.innerText()).trim() === "High");
    assert.deepEqual(modelRequests, [false, true]);

    const composer = page.locator(".composer-input");
    async function send(text) {
        await composer.fill(text);
        await composer.press("Enter");
        await until(`request for ${text}`, () => chats.some((body) => JSON.stringify(body.messages ?? []).includes(text)));
        const request = chats.find((body) => JSON.stringify(body.messages ?? []).includes(text));
        await until("the turn to finish", async () => await page.locator(".send-button").getAttribute("data-mode") === "send");
        assert.equal(request.model, "deepseek-flash");
        return request;
    }
    const high = await send("Ahoy from the crow at high");
    assert.deepEqual(high.thinking, { type: "enabled" });
    assert.equal(high.reasoning_effort, "high");

    async function chooseEffort(keyName, expected) {
        await pill.click();
        const slider = page.locator('.effort-pop input[type="range"]');
        await slider.waitFor();
        await slider.press(keyName);
        await until(`effort ${expected}`, async () => (await slider.getAttribute("aria-valuetext"))?.toLowerCase() === expected.toLowerCase());
        await page.keyboard.press("Escape");
        await until(`effort pill ${expected}`, async () => (await pill.innerText()).trim() === expected);
    }
    await chooseEffort("End", "Max");
    const max = await send("Ahoy from the crow at max");
    assert.deepEqual(max.thinking, { type: "enabled" });
    assert.equal(max.reasoning_effort, "max");
    await chooseEffort("Home", "Off");
    const off = await send("Ahoy from the crow with thinking off");
    assert.deepEqual(off.thinking, { type: "disabled" });
    assert.equal(off.reasoning_effort, undefined);
    assert.deepEqual(modelRequests, [false, true]);
    console.log("DeepSeek setup and effort requests passed.");
} finally {
    try {
        await trial.cleanup();
    } finally {
        if (listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
}
