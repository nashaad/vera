// /btw test for the desktop composer. Run with: node clients/desktop/test/btw.e2e.mjs
// /btw opens a readonly sidekick in a Chat tab and asks it there; the main conversation gets nothing.
// The task process that reads which included extensions are on runs per request and none is left running.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { COUNT_PROCESSES, startTrial } from "./trial.mjs";

const MAIN_REPLY = "Crows sail past the reef.";
const SIDE_REPLY = "The reef lies south of the fence.";
const BOUNDARY = "Side conversation boundary.";
const SERVICE = "Vera Model Assignments";
const FIRST = "Where is the reef?";
const SECOND = "And the fence?";

const requests = [];

const provider = createServer((request, response) => {
    if (request.method === "GET" && request.url.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "crow-0" }] }));
        return;
    }
    let raw = "";
    request.on("data", (part) => { raw += part; });
    request.on("end", () => {
        const body = JSON.parse(raw);
        const text = JSON.stringify(body.messages ?? []);
        const side = text.includes(BOUNDARY);
        requests.push({ side, text });
        const reply = side ? SIDE_REPLY : MAIN_REPLY;
        const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
        if (body.stream === false) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ id: "reply", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage }));
            return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(streamChunk(body.model, { content: reply }));
        response.write(`data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
        response.end("data: [DONE]\n\n");
    });
});

const trial = startTrial();
let failed = false;
let page;
let app;

const pane = '[data-location="rightPane"]';
const chatTabs = () => page.locator(`${pane} [data-switcher="rightPane"] [data-tab][data-container="core.chat"]`);
const side = () => page.locator(`${pane} .chat-view[data-chat="sidekick"]`);
const processes = () => app.evaluate(({ app: electron }, service) => ({
    started: globalThis.utilityStarts[service] ?? 0,
    running: electron.getAppMetrics().filter((metric) => metric.name === service).length,
}), SERVICE);

async function boot(folder) {
    app = await trial.launch({ args: COUNT_PROCESSES });
    await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, folder);
    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions]", { timeout: 45_000 });
    await trial.waitForHost();
}

async function startSession(folder) {
    const input = page.locator(".home-composer .composer-input");
    await input.fill("Hello crow");
    await page.getByRole("button", { name: /No folder/ }).click();
    await page.getByRole("menuitem", { name: /Open folder/ }).click();
    await page.waitForSelector(`.context-chips .chip-label:text-is("${folder.split("/").pop()}")`);
    await input.press("Enter");
    await page.waitForSelector("[data-session][data-phase=\"attached\"]", { timeout: 45_000 });
    await page.waitForSelector(`text=${MAIN_REPLY}`, { timeout: 30_000 });
    await until("the turn to end", async () => (await page.locator(".send-button").getAttribute("data-mode")) === "send");
}

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port);
    const folder = join(trial.home, "..", "work");
    mkdirSync(folder, { recursive: true });

    // No task process runs at launch or while New Chat is showing.
    await boot(folder);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    let counted = await processes();
    if (counted.started !== 0 || counted.running !== 0) throw new Error(`The task ran at launch: ${JSON.stringify(counted)}.`);

    await startSession(folder);
    const input = page.locator(".composer-input").first();
    const menu = page.locator(".slash-menu");
    await input.fill("/bt");
    await menu.waitFor({ timeout: 15_000 });
    const row = page.locator('.slash-item:has(.slash-name:text-is("/btw"))');
    await row.waitFor();
    const description = await row.innerText();
    if (!description.includes("Open or message a readonly sidekick")) throw new Error(`The /btw row reads "${description}".`);
    await input.fill("");
    await until("the task process to stop", async () => {
        counted = await processes();
        return counted.started >= 1 && counted.running === 0;
    });
    const mainRequests = requests.filter((entry) => !entry.side).length;

    // /btw with a question opens a sidekick tab and asks it there.
    await input.fill(`/btw ${FIRST}`);
    await input.press("Enter");
    await chatTabs().first().waitFor({ timeout: 15_000 });
    await side().waitFor({ timeout: 15_000 });
    await side().locator(`text=${SIDE_REPLY}`).waitFor({ timeout: 45_000 });
    if ((await chatTabs().first().getAttribute("title")) !== "Btw") throw new Error("The sidekick tab title attribute is not Btw.");
    if ((await chatTabs().first().innerText()).trim() !== "Btw") throw new Error("The sidekick tab is not titled Btw.");
    if ((await input.inputValue()) !== "") throw new Error("/btw left its text in the main box.");
    const sideRequest = requests.find((entry) => entry.side);
    if (sideRequest === undefined) throw new Error("No request carried the side conversation boundary.");
    if (!sideRequest.text.includes(FIRST)) throw new Error("The question did not reach the sidekick.");
    if (!sideRequest.text.includes("Hello crow")) throw new Error("The sidekick did not inherit the conversation.");
    await until("the sidekick to report readonly", async () => (await side().locator(".approval-picker .pill-label").innerText()).toLowerCase().includes("read"));
    if ((await page.locator(".approval-picker .pill-label").first().innerText()).toLowerCase().includes("read")) throw new Error("The main conversation is readonly.");
    if (requests.filter((entry) => !entry.side).length !== mainRequests) throw new Error("/btw sent a request on the main conversation.");
    const main = page.locator("main .transcript-scroll[data-session]");
    if ((await main.innerText()).includes(FIRST)) throw new Error("The question shows in the main transcript.");

    // A second /btw reuses the tab.
    await input.fill(`/btw ${SECOND}`);
    await input.press("Enter");
    await until("the second question to reach the sidekick", async () => requests.some((entry) => entry.side && entry.text.includes(SECOND)));
    if ((await chatTabs().count()) !== 1) throw new Error("A second /btw opened a second tab.");
    await side().locator(`text=${SECOND}`).waitFor({ timeout: 15_000 });
    if ((await main.innerText()).includes(SECOND)) throw new Error("The second question shows in the main transcript.");

    // /btw close closes the tab.
    await input.fill("/btw close");
    await input.press("Enter");
    await until("the Chat tab to close", async () => (await chatTabs().count()) === 0);

    // /btw alone opens a new sidekick without sending anything.
    const sent = requests.filter((entry) => entry.side).length;
    await input.fill("/btw");
    await input.press("Enter");
    await side().waitFor({ timeout: 15_000 });
    await side().locator('[data-session][data-phase="attached"]').waitFor({ timeout: 45_000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (requests.filter((entry) => entry.side).length !== sent) throw new Error("/btw alone sent a request.");
    await page.locator(`${pane} .switcher-close`).first().click();
    await until("the sidekick tab to close", async () => (await chatTabs().count()) === 0);

    counted = await processes();
    if (counted.running !== 0) throw new Error(`A task process is left running: ${JSON.stringify(counted)}.`);
    console.log(`task process starts after the session: ${counted.started}`);

    // The request time of the task, measured in the window.
    const times = await page.evaluate(async () => {
        const out = [];
        for (let index = 0; index < 5; index += 1) {
            const started = performance.now();
            const result = await window.veraDesktop.readIncludedExtensions();
            if (!result.ok) throw new Error(result.reason);
            out.push(Math.round(performance.now() - started));
        }
        return out;
    });
    const before = counted.started;
    counted = await processes();
    if (counted.started - before !== 5) throw new Error(`Five requests started ${counted.started - before} processes.`);
    await until("the task process to stop", async () => (await processes()).running === 0);
    console.log(`included-extensions request times in ms: ${times.join(", ")}`);

    // Turned off in config.json, /btw is not offered and a typed /btw is not sent as a message.
    await app.close();
    const config = JSON.parse(readFileSync(join(trial.home, "config.json"), "utf8"));
    config.disabled_included_extensions = ["vera.btw"];
    writeFileSync(join(trial.home, "config.json"), JSON.stringify(config, null, 2));
    requests.length = 0;
    await boot(folder);
    await startSession(folder);
    const off = page.locator(".composer-input").first();
    await off.fill("/");
    await page.locator(".slash-menu").waitFor({ timeout: 15_000 });
    await page.locator(".slash-item .slash-name").first().waitFor();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const names = await page.locator(".slash-item .slash-name").allInnerTexts();
    if (names.includes("/btw")) throw new Error("/btw is offered while the extension is turned off.");
    await off.fill(`/btw ${FIRST}`);
    await off.press("Enter");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if ((await chatTabs().count()) !== 0) throw new Error("/btw opened a tab while the extension is turned off.");
    if (requests.some((entry) => entry.side || entry.text.includes(FIRST))) throw new Error("/btw sent a request while the extension is turned off.");
    counted = await processes();
    await until("the task process to stop", async () => (await processes()).running === 0);

    console.log("btw e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    if (page !== undefined) console.error("Page text:", await page.locator(".app").first().innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
}
process.exit(failed ? 1 : 0);
