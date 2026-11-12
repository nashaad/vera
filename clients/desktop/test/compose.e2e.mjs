// Composer test for the desktop shell. Run with: node clients/desktop/test/compose.e2e.mjs
// A local provider streams fixed replies; the trial home points its only model at it.

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { startTrial } from "./trial.mjs";

const REPLY = "Crows sail past the reef.";
const SLOW_REPLY_CHUNKS = 120;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const requests = [];

function lastUserText(body) {
    const user = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
    return JSON.stringify(user?.content ?? "");
}

const provider = createServer((request, response) => {
    if (request.method === "GET" && request.url.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "crow-0" }] }));
        return;
    }
    let raw = "";
    request.on("data", (part) => { raw += part; });
    request.on("end", async () => {
        const body = JSON.parse(raw);
        const text = lastUserText(body);
        requests.push(text);
        const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
        if (body.stream === false) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({
                id: "reply",
                model: body.model,
                choices: [{ index: 0, message: { role: "assistant", content: REPLY }, finish_reason: "stop" }],
                usage,
            }));
            return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        let closed = false;
        response.on("close", () => { closed = true; });
        const slow = text.includes("SLOW");
        const parts = slow ? Array.from({ length: SLOW_REPLY_CHUNKS }, () => " caw") : REPLY.split(/(?= )/);
        for (const part of parts) {
            if (closed) return;
            response.write(streamChunk(body.model, { content: part }));
            await new Promise((resolve) => setTimeout(resolve, slow ? 250 : 40));
        }
        if (closed) return;
        response.write(`data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
        response.end("data: [DONE]\n\n");
    });
});

// The first prompt of a session is a heading, later ones are bubbles.
const USER = ":is(.user-turn, .user-bubble)";

const trial = startTrial();
let failed = false;
let page;

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port);
    const folder = join(trial.home, "..", "work");
    mkdirSync(folder, { recursive: true });
    const image = join(trial.home, "..", "crow.png");
    writeFileSync(image, Buffer.from(PNG, "base64"));

    const app = await trial.launch();
    // The native pickers are stubbed: folders come back as the work folder, files as the PNG.
    await app.evaluate(({ dialog }, paths) => {
        dialog.showOpenDialog = async (first, second) => {
            const options = second ?? first;
            const folderPick = options.properties.includes("openDirectory");
            return { canceled: false, filePaths: [folderPick ? paths.folder : paths.image] };
        };
    }, { folder, image });

    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: 45_000 });
    await trial.waitForHost();

    // New Chat: pick the folder, type, Enter. The prompt goes out once the new session attaches.
    await page.getByRole("button", { name: /No folder/ }).click();
    await page.getByRole("menuitem", { name: /Open folder/ }).click();
    await page.waitForSelector(".context-chips .chip-label:text-is(\"work\")");
    const input = page.locator(".composer-input");
    await input.fill("Hello crow");
    await input.press("Enter");
    await page.waitForSelector("[data-session][data-phase=\"attached\"]", { timeout: 45_000 });
    await page.waitForSelector(`${USER}:text-is("Hello crow")`, { timeout: 30_000 });
    await page.waitForSelector(`text=${REPLY}`, { timeout: 30_000 });
    await page.waitForSelector(".context-chips .chip-label:text-is(\"work\")");

    const send = page.locator(".send-button");
    const sendMode = () => send.getAttribute("data-mode");

    // Queue while a turn runs, take it back with ArrowUp, queue it again, then release it.
    await input.fill("SLOW one");
    await input.press("Enter");
    await until("the stop button", async () => (await sendMode()) === "stop");
    await input.fill("queued note");
    await input.press("Enter");
    await page.waitForSelector(".queue-strip .queue-first:has-text(\"queued note\")");
    await input.press("ArrowUp");
    await until("the withdrawn prompt", async () => (await input.inputValue()) === "queued note");
    await page.waitForSelector(".queue-strip", { state: "detached" });
    await input.press("Enter");
    await page.waitForSelector(".queue-strip .queue-first:has-text(\"queued note\")");
    await input.press("Enter");
    await page.waitForSelector(`${USER}:text-is("queued note")`, { timeout: 30_000 });
    await page.waitForSelector(".queue-strip", { state: "detached" });
    await until("the released turn to finish", async () => (await sendMode()) === "send");

    // Stop a running turn from the button.
    await input.fill("SLOW two");
    await input.press("Enter");
    await until("the stop button", async () => (await sendMode()) === "stop");
    await send.click();
    await until("the stopped turn", async () => (await sendMode()) === "send"
        && (await input.getAttribute("placeholder")) === "Reply to Vera");

    // Attach an image from the picker; the prompt carries it once the host has a copy.
    await page.getByRole("button", { name: "Attach images" }).click();
    await page.waitForSelector(".chip-file[data-attaching=\"false\"]", { timeout: 15_000 });
    const before = requests.length;
    await input.fill("What is in the picture?");
    await input.press("Enter");
    await page.waitForSelector(`${USER}:text-is("What is in the picture?")`, { timeout: 30_000 });
    await page.waitForSelector(".chip-file", { state: "detached" });
    await until("the image request", async () => requests.slice(before).some((text) => text.includes("data:image/png")));
    console.log("compose e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    console.error("Provider saw:", requests);
    if (page !== undefined) console.error("Page text:", await page.locator(".transcript-scroll, .app").first().innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
}
process.exit(failed ? 1 : 0);
