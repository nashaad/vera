// Start session test for the desktop shell. Run with: node clients/desktop/test/startsession.e2e.mjs
// The host stops a session while its page is open: the page, the context pill and Customize
// each say it is not running and offer Start session. Starting resumes it on the host without
// sending a message, and the view loads without another click.

import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { startTrial } from "./trial.mjs";

const REPLY = "The crow settles on the branch.";
const STOPPED = "The host closed this session.";

let turns = 0;
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
        if (body.stream === false) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({
                id: "reply",
                model: body.model,
                choices: [{ index: 0, message: { role: "assistant", content: "Crow notes" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
            }));
            return;
        }
        const last = String(body.messages?.at(-1)?.content ?? "");
        // The title request is a streamed call that quotes the conversation; it is not a turn.
        if (!last.startsWith("User:\n")) turns += 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const part of REPLY.split(/(?= )/)) response.write(streamChunk(body.model, { content: part }));
        response.write(streamChunk(body.model, {}, "stop"));
        response.end("data: [DONE]\n\n");
    });
});

const trial = startTrial();
let failed = false;
let page;

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port, "auto");
    const folder = join(trial.home, "..", "nest");
    mkdirSync(folder, { recursive: true });

    const app = await trial.launch();
    await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, folder);

    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: 45_000 });
    await trial.waitForHost();

    await page.getByRole("button", { name: /No folder/ }).click();
    await page.getByRole("menuitem", { name: /Open folder/ }).click();
    await page.waitForSelector(".context-chips .chip-label:text-is(\"nest\")");
    const input = page.locator(".composer-input");
    const send = page.locator(".send-button");
    await input.fill("Tell me about crows");
    await input.press("Enter");
    await page.waitForSelector("[data-session][data-phase=\"attached\"]", { timeout: 45_000 });
    await page.waitForSelector(`text=${REPLY}`, { timeout: 45_000 });
    await until("the turn to end", async () => (await send.getAttribute("data-mode")) === "send");
    const agentId = await page.locator("[data-session][data-phase]").first().getAttribute("data-session");
    const row = page.locator(`.session-row[data-session="${agentId}"]`);
    const stop = async () => {
        const result = await page.evaluate((id) => window.veraDesktop.closeSession(id), agentId);
        if (!result.ok) throw new Error(`The host would not close the session: ${JSON.stringify(result)}`);
    };
    if (await row.getAttribute("data-live") !== "true") throw new Error("The session is not running before it was stopped.");
    if (await page.locator("[data-start-session]").count() !== 0) throw new Error("A running session offers Start session.");

    // The host stops the session under its open page: the page keeps the conversation and offers the start.
    await stop();
    const strip = page.locator(".transcript-notice[data-start=\"true\"]");
    await strip.waitFor({ timeout: 15_000 });
    if (!(await strip.innerText()).includes(STOPPED)) throw new Error(`The strip says ${await strip.innerText()}`);
    await page.locator(`text=${REPLY}`).first().waitFor({ timeout: 5_000 });
    if (!(await page.locator(".composer-input").isDisabled())) throw new Error("The composer takes a message for a stopped session.");

    // The context pill says the same, in place of Compact.
    await page.locator(".context-pill").click();
    const pop = page.locator(".context-pop");
    await pop.getByText("This session is not running.").waitFor({ timeout: 5_000 });
    if (await pop.getByRole("button", { name: "Compact" }).count() !== 0) throw new Error("A stopped session offers Compact.");
    await pop.locator("[data-start-session]").waitFor({ timeout: 5_000 });
    await page.keyboard.press("Escape");
    await pop.waitFor({ state: "detached", timeout: 5_000 });

    // Start session resumes it: the conversation loads again, the row runs, and nothing was sent.
    await strip.locator("[data-start-session]").click();
    await page.waitForSelector("[data-session][data-phase=\"attached\"]", { timeout: 30_000 });
    await strip.waitFor({ state: "detached", timeout: 15_000 });
    await page.locator(`text=${REPLY}`).first().waitFor({ timeout: 15_000 });
    await until("the composer to take a message", async () => !(await page.locator(".composer-input").isDisabled()));
    await until("the session to run", async () => (await row.getAttribute("data-live")) === "true", 30_000);
    if (turns !== 1) throw new Error(`Starting the session sent a message: ${turns} turns.`);
    if (await page.locator(".turn").count() > 1) throw new Error("Starting the session added a turn.");

    // Customize reads through the session, so for a stopped one it asks before starting it.
    await stop();
    await strip.waitFor({ timeout: 15_000 });
    await until("the row to show the session stopped", async () => (await row.getAttribute("data-live")) === "false", 30_000);
    await page.locator("[data-page=\"customize\"]").first().click();
    await page.waitForSelector("main[data-page=\"customize\"]", { timeout: 10_000 });
    const offer = page.locator(".empty-state", { hasText: "This session is not running" });
    await offer.waitFor({ timeout: 10_000 });
    await offer.locator("[data-start-session]").waitFor({ timeout: 5_000 });
    // The desktop extensions are listed with or without a session, so only the session's own items are counted.
    if (await page.locator(".customize-card:not([data-desktop-extension])").count() !== 0) throw new Error("Customize listed items before the session started.");
    // Sessions refresh every few seconds; the row stays stopped across several of them.
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    if (await row.getAttribute("data-live") !== "false") throw new Error("Opening Customize started the session.");

    await offer.locator("[data-start-session]").click();
    await page.locator(".customize-card[data-kind=\"skills\"][data-name=\"vera-help\"]").waitFor({ timeout: 30_000 });
    await offer.waitFor({ state: "detached", timeout: 5_000 });
    if (turns !== 1) throw new Error(`Reading the session sent a message: ${turns} turns.`);
    console.log("startsession e2e passed");
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
