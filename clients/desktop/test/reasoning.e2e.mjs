// Reasoning progress test for the desktop shell. Run with: node clients/desktop/test/reasoning.e2e.mjs
// With Reasoning off the window asks the host for a character count in place of the reasoning text, and its
// meter counts those characters. With Reasoning on it receives and draws the text. Changing the choice in
// Settings, or while a session is open, attaches the session again, including in the middle of a turn.

import { createServer } from "node:http";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { MODIFIER, press, startTrial } from "./trial.mjs";

const THOUGHTS = Array.from({ length: 20 }, (_, index) => `thought ${String(index).padStart(2, "0")} weighs the nest twigs. `);
const REASONING = THOUGHTS.join("");
const ANSWER = "The crow circles the nest twice and settles on the highest branch before dusk.";
const LONG_TIMEOUT = 45_000;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A prompt that says HOLD keeps the provider from answering until the test lets it.
let held = false;
let release;

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
        const messages = body.messages ?? [];
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
        response.writeHead(200, { "content-type": "text/event-stream" });
        let closed = false;
        response.on("close", () => { closed = true; });
        const lastUser = messages.findLast((message) => message.role === "user");
        const hold = JSON.stringify(lastUser?.content ?? "").includes("HOLD");
        for (let index = 0; index < THOUGHTS.length; index += 1) {
            const delta = index === 0 ? { role: "assistant", reasoning_content: THOUGHTS[index] } : { reasoning_content: THOUGHTS[index] };
            response.write(streamChunk(body.model, delta));
            await pause(60);
        }
        if (hold) {
            held = true;
            await new Promise((resolve) => { release = resolve; });
            held = false;
        }
        const words = ANSWER.split(" ");
        for (let index = 0; index < words.length; index += 1) {
            if (closed) return;
            response.write(streamChunk(body.model, { content: index === 0 ? words[index] : ` ${words[index]}` }));
            await pause(200);
        }
        response.write(streamChunk(body.model, {}, "stop"));
        response.end("data: [DONE]\n\n");
    });
});

// Records what the main process hands the window, so the test sees which updates reach it.
async function recordFrames(app) {
    await app.evaluate(({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        const send = contents.send.bind(contents);
        globalThis.sessionFrames = [];
        contents.send = (channel, ...args) => {
            const event = args[0];
            if (event?.type === "session_frame") globalThis.sessionFrames.push(event.text);
            return send(channel, ...args);
        };
    });
}

async function frameCount(app) {
    return app.evaluate(() => globalThis.sessionFrames.length);
}

async function summarySince(app, mark) {
    const texts = await app.evaluate((_, from) => globalThis.sessionFrames.slice(from), mark);
    const summary = { histories: 0, thinkingFrames: 0, thinkingText: "", progressFrames: 0, progressCharacters: 0 };
    for (const text of texts) {
        const frame = JSON.parse(text);
        if (frame.type === "history") summary.histories += 1;
        if (frame.type === "assistant_thinking") {
            summary.thinkingFrames += 1;
            summary.thinkingText += frame.text;
        }
        if (frame.type === "assistant_thinking_progress") {
            summary.progressFrames += 1;
            summary.progressCharacters += frame.characters;
        }
    }
    return summary;
}

function expectProgress(summary, label) {
    if (summary.thinkingFrames !== 0) throw new Error(`${label}: the window received ${summary.thinkingFrames} reasoning text updates.`);
    if (summary.progressFrames === 0) throw new Error(`${label}: the window received no progress updates.`);
    if (summary.progressCharacters !== REASONING.length) {
        throw new Error(`${label}: progress counted ${summary.progressCharacters} characters, expected ${REASONING.length}.`);
    }
}

function expectText(summary, label) {
    if (summary.progressFrames !== 0) throw new Error(`${label}: the window received ${summary.progressFrames} progress updates.`);
    if (summary.thinkingText !== REASONING) throw new Error(`${label}: the reasoning text was ${JSON.stringify(summary.thinkingText.slice(0, 80))}.`);
}

// Samples the token count of the status line in the page, which only shows once the answer is writing.
async function sampleMeter(page) {
    await page.evaluate(() => {
        window.tokenSamples = [];
        window.tokenTimer = setInterval(() => {
            const match = /([\d,]+) tokens/.exec(document.querySelector(".live-status")?.textContent ?? "");
            if (match) window.tokenSamples.push(Number(match[1].replace(/,/g, "")));
        }, 50);
    });
}

async function meterReading(page, label) {
    const samples = await page.evaluate(() => {
        clearInterval(window.tokenTimer);
        return window.tokenSamples;
    });
    const wanted = Math.ceil(REASONING.length / 4);
    const top = Math.max(0, ...samples);
    if (top < wanted) throw new Error(`${label}: the meter reached ${top} tokens, expected at least ${wanted}.`);
}

async function main() {
    const trial = startTrial();
    let failed = false;
    let page;
    try {
        await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
        configureFauxHome(trial.home, provider.address().port);
        const app = await trial.launch();
        page = await app.firstWindow();
        await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: LONG_TIMEOUT });
        await trial.waitForHost();
        await recordFrames(app);

        const input = page.locator(".composer-input");
        const answers = page.locator(".assistant-text", { hasText: ANSWER });
        const attached = "[data-session][data-phase=\"attached\"]";
        const sessionRow = () => page.locator(".session-row").first();

        const ask = async (text) => {
            await sampleMeter(page);
            await input.fill(text);
            await input.press("Enter");
        };
        const finish = async (expectedAnswers) => {
            await until(`${expectedAnswers} answers`, async () => (await answers.count()) === expectedAnswers, LONG_TIMEOUT);
            await page.waitForSelector(".live-status", { state: "detached", timeout: LONG_TIMEOUT });
            await pause(500);
        };
        const goToSettings = async () => {
            await press(app, ",", [MODIFIER]);
            await page.waitForSelector("main[data-page=\"settings\"]", { timeout: 10_000 });
            await page.locator(".rail-row").filter({ has: page.getByText("Show", { exact: true }) }).click();
            await page.locator("h1", { hasText: "Show" }).waitFor({ timeout: 10_000 });
        };
        const chooseReasoning = async (choice) => {
            await goToSettings();
            await page.locator("[role=\"group\"][aria-label=\"Reasoning\"]").getByRole("button", { name: choice, exact: true }).click();
            await pause(500);
        };
        const backToSession = async () => {
            await sessionRow().click();
            await page.waitForSelector(attached, { timeout: LONG_TIMEOUT });
        };
        const saveFlag = (choice) => page.evaluate((value) => window.veraDesktop.saveFlags({ showReasoning: value }), choice);

        // Reasoning is off by default: the window gets counts, draws no thoughts and its meter counts them.
        let mark = await frameCount(app);
        await ask("Count the twigs");
        await page.waitForSelector(attached, { timeout: LONG_TIMEOUT });
        await finish(1);
        expectProgress(await summarySince(app, mark), "Off");
        if (await page.locator(".thought-line, .thinking-live").count() !== 0) throw new Error("Off: reasoning showed in the window.");
        await meterReading(page, "Off");

        // Turning Reasoning on in Settings gives the next attach the text, and the window draws it.
        await chooseReasoning("On");
        mark = await frameCount(app);
        await backToSession();
        await page.waitForSelector(".thought-line", { timeout: 10_000 });
        await ask("Count the twigs again");
        await page.waitForSelector(".thinking-live", { timeout: 30_000 });
        await finish(2);
        expectText(await summarySince(app, mark), "On");
        if (await page.locator(".thought-line").count() < 2) throw new Error("On: the thoughts did not show after the turn.");
        await meterReading(page, "On");

        // Turning it off while a turn is waiting on the model: the session attaches again with counts, once.
        await ask("Count the twigs once more, HOLD");
        await until("the provider to hold", async () => held, LONG_TIMEOUT);
        await page.waitForSelector(".thinking-live", { timeout: 30_000 });
        await chooseReasoning("Off");
        mark = await frameCount(app);
        await backToSession();
        await until("the session to load again", async () => (await summarySince(app, mark)).histories > 0, 10_000);
        release();
        await finish(3);
        expectProgress(await summarySince(app, mark), "Off in a turn");
        await meterReading(page, "Off in a turn");

        // The same change while the session stays open, as a second window or a script would make it.
        await ask("Count the twigs, one last time, HOLD");
        await until("the provider to hold", async () => held, LONG_TIMEOUT);
        await pause(500);
        mark = await frameCount(app);
        await saveFlag("on");
        await until("the open session to attach again", async () => (await summarySince(app, mark)).histories > 0, 10_000);
        release();
        await finish(4);
        expectText(await summarySince(app, mark), "On while open");
        await meterReading(page, "On while open");

        // Saving the choice it already has attaches nothing.
        mark = await frameCount(app);
        await saveFlag("on");
        await pause(800);
        if ((await summarySince(app, mark)).histories !== 0) throw new Error("An unchanged choice attached the session again.");

        // Every turn is on the page once: four prompts, four answers.
        const prompts = await page.locator(".user-turn, .user-bubble").count();
        if (prompts !== 4) throw new Error(`The page shows ${prompts} prompts, expected 4.`);
        console.log("reasoning e2e passed");
    } catch (error) {
        failed = true;
        console.error(error);
        if (page !== undefined) console.error("Page text:", await page.locator(".app").first().innerText().catch(() => "unreadable"));
    } finally {
        release?.();
        await trial.cleanup();
        provider.closeAllConnections();
        await new Promise((resolve) => provider.close(resolve));
    }
    process.exit(failed ? 1 : 0);
}

await main();
