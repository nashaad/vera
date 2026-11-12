// Transcript test for the desktop shell. Run with: node clients/desktop/test/transcript.e2e.mjs
// The provider writes a plan, reads a file, runs a slow command, then streams its answer slowly.
// While the turn runs the window shows one status line, the plan card and fading words; afterwards
// the calls are one summary line that opens into rows. Reasoning stays hidden unless
// <home>/machine/desktop/flags.json turns it on.

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { startTrial } from "./trial.mjs";

const ANSWER = "The crow circles the nest twice and settles on the highest branch before dusk falls over the harbor.";
const PLAN = "# Crow plan\n\n- [x] Look at the nest\n- [ ] Count the twigs\n";
const requests = [];
let calls = 0;

function scratchIn(raw) {
    return /(\/[^"\\\s]*\/vera\/[A-Za-z0-9_-]+)/.exec(raw)?.[1];
}

// One call per step of the GO prompt, chosen by how many tool results follow it.
function stepFor(messages, scratch) {
    const lastUser = messages.findLastIndex((message) => message.role === "user");
    if (!JSON.stringify(messages[lastUser]?.content ?? "").includes("GO")) return undefined;
    const results = messages.slice(lastUser + 1).filter((message) => message.role === "tool").length;
    if (results === 0) return { name: "write", input: { path: join(scratch ?? "missing-scratch", "plan.md"), content: PLAN } };
    if (results === 1) return { name: "read", input: { path: "nest.txt" } };
    if (results === 2) return { name: "bash", input: { command: "sleep 4 && echo caw" } };
    return undefined;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
        requests.push({ role: messages.at(-1)?.role, stream: body.stream });
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
        const step = stepFor(messages, scratchIn(raw));
        if (step === undefined) {
            const words = ANSWER.split(" ");
            for (let index = 0; index < words.length; index += 1) {
                const content = index === 0 ? words[index] : ` ${words[index]}`;
                response.write(streamChunk(body.model, index === 0 ? { role: "assistant", content } : { content }));
                await pause(250);
            }
            response.write(streamChunk(body.model, {}, "stop"));
        } else {
            calls += 1;
            const call = { index: 0, id: `call-${calls}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.input) } };
            response.write(streamChunk(body.model, { role: "assistant", reasoning_content: "Weighing the nest.", tool_calls: [call] }, "tool_calls"));
        }
        response.end("data: [DONE]\n\n");
    });
});

const trial = startTrial();
let failed = false;
let page;

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port, "auto");
    const folder = join(trial.home, "..", "work");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "nest.txt"), "twigs\nmud\n");

    const app = await trial.launch();
    await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, folder);

    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: 45_000 });
    await trial.waitForHost();

    await page.getByRole("button", { name: /No folder/ }).click();
    await page.getByRole("menuitem", { name: /Open folder/ }).click();
    await page.waitForSelector(".context-chips .chip-label:text-is(\"work\")");
    const input = page.locator(".composer-input");
    const send = page.locator(".send-button");
    await input.fill("Look at the nest, GO");
    await input.press("Enter");
    await page.waitForSelector("[data-session][data-phase=\"attached\"]", { timeout: 45_000 });

    // While a command runs the status line names it, and no call has a row of its own.
    const status = page.locator(".live-status");
    await page.waitForSelector(".live-status[data-state=\"tool\"]", { timeout: 45_000 });
    const text = await status.innerText();
    if (!/Running/.test(text) || !/sleep 4/.test(text)) throw new Error(`The status line was ${JSON.stringify(text)}`);
    if (await page.locator(".live-status .live-dots > span").count() !== 3) throw new Error("The status line does not have three dots.");
    if (await page.locator(".call-line, .run-head").count() !== 0) throw new Error("A running turn drew rows for its calls.");
    if (await status.count() !== 1) throw new Error("The turn has more than one status line.");

    // Clicking the status line opens the calls in progress.
    await status.click();
    await page.locator(".live-status-wrap .call-list .call-line").first().waitFor({ timeout: 5_000 });
    await status.click();

    // The plan the turn wrote shows as a card while the turn runs.
    await page.locator(".task-card .task-text", { hasText: "Count the twigs" }).waitFor({ timeout: 10_000 });
    if (await page.locator(".task-card .task-row[data-done=\"true\"]").count() !== 1) throw new Error("The task card does not mark the done item.");
    if (await page.locator("[data-pane=\"plan\"], .plan-title").count() !== 0) throw new Error("The Plan view opened by itself.");

    // The answer streams word by word, and the status line counts tokens.
    await page.waitForSelector(".live-status[data-state=\"writing\"]", { timeout: 30_000 });
    await page.locator(".assistant-text .word-in").first().waitFor({ timeout: 5_000 });
    const writing = await status.innerText();
    if (!/\d+s · [\d,]+ tokens/.test(writing)) throw new Error(`The writing status was ${JSON.stringify(writing)}`);
    if (await status.count() !== 1) throw new Error("The status line moved while text streamed.");

    // With the turn over the status line, plan card and word spans are gone and the calls are one line.
    await until("the turn to end", async () => (await send.getAttribute("data-mode")) === "send", 60_000);
    if (await page.locator(".live-status, .task-card, .word-in").count() !== 0) throw new Error("A live element outlived the turn.");
    const run = page.locator(".run-head");
    await run.waitFor({ timeout: 10_000 });
    const summary = await run.innerText();
    if (!/Wrote a file, read a file, ran a command/.test(summary)) throw new Error(`The run line was ${JSON.stringify(summary)}`);
    if (await page.locator(".thought-line, .thinking-live").count() !== 0) throw new Error("Reasoning showed with the flag off.");

    // The line opens into flat rows, and a shell call opens into a box with its output.
    await run.click();
    const rows = page.locator(".call-list .call-line");
    await until("three rows", async () => (await rows.count()) === 3);
    await rows.nth(2).click();
    const box = page.locator(".shell-box");
    await box.waitFor({ timeout: 5_000 });
    const shell = await box.innerText();
    if (!/sleep 4 && echo caw/.test(shell) || !/\bcaw\b/.test(shell.replace("sleep 4 && echo caw", ""))) throw new Error(`The shell box was ${JSON.stringify(shell)}`);

    // A flags file that turns reasoning on brings the Thought rows back after a restart.
    const flags = join(trial.home, "machine", "desktop");
    mkdirSync(flags, { recursive: true });
    writeFileSync(join(flags, "flags.json"), "{\"showReasoning\": true}\n");
    await app.close();
    const again = await trial.launch();
    page = await again.firstWindow();
    await page.waitForSelector(".app", { timeout: 45_000 });
    await page.locator(".session-row").first().click({ timeout: 45_000 });
    await page.locator(".thought-line").first().waitFor({ timeout: 30_000 });
    console.log("transcript e2e passed");
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
