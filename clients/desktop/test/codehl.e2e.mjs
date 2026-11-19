// Code highlighting test for the desktop shell. Run with: node clients/desktop/test/codehl.e2e.mjs
// The provider streams a reply with a TypeScript block, a block in a language with no grammar and a
// shell block, holding the TypeScript fence open until the test lets it close. A block stays plain
// while its fence is open and is colored as soon as the fence closes, mid-reply. An unknown language
// stays plain, the copy button gives the plain code, and the colors follow the theme. A block far from the
// screen goes back to plain text and is colored again when it comes back.

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { MODIFIER, press, startTrial } from "./trial.mjs";

const TS_CODE = "const crow: number = 1; // caw\nfunction land(nest: string) {\n    return `landed on ${nest}`;\n}";
const requests = [];

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

const fenceOpen = deferred();
const fenceClosed = deferred();
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
        requests.push({ stream: body.stream });
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
        let first = true;
        if (JSON.stringify(body.messages).includes("Write the filler")) {
            const filler = Array.from({ length: 200 }, (_, index) => `Crow paragraph ${index}.`).join("\n\n");
            response.write(streamChunk(body.model, { role: "assistant", content: `${filler}\n\n\`\`\`ts\nconst nest = 2;\n\`\`\`\n\nDone.` }));
            response.write(streamChunk(body.model, {}, "stop"));
            response.end("data: [DONE]\n\n");
            return;
        }
        const send = (content) => {
            response.write(streamChunk(body.model, first ? { role: "assistant", content } : { content }));
            first = false;
        };
        send("Here is the nest code.\n\n```ts\n");
        for (const line of TS_CODE.split("\n")) {
            await pause(60);
            send(`${line}\n`);
        }
        // The fence stays open until the test has looked at the block.
        fenceOpen.resolve();
        await fenceClosed.promise;
        send("```\n\nThen a language with no grammar.\n\n```nest\nconst crow = 1;\n```\n\n");
        await pause(5_000);
        send("And a shell line.\n\n```bash\necho \"caw\" | wc -c\n```\n\nDone.");
        response.write(streamChunk(body.model, {}, "stop"));
        response.end("data: [DONE]\n\n");
    });
});

const trial = startTrial();
let failed = false;
let page;
const refused = [];

function expectEqual(actual, expected, label) {
    if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
}

function colorOf(locator) {
    return locator.first().evaluate((element) => getComputedStyle(element).color);
}

async function openAppearance(app) {
    await press(app, "K", [MODIFIER]);
    const palette = page.locator("input[aria-label=\"Command palette\"]");
    await palette.waitFor({ timeout: 10_000 });
    await palette.fill("settings");
    await page.locator(".palette-row[data-command=\"go.settings\"]").waitFor({ timeout: 10_000 });
    await palette.press("Enter");
    await page.waitForSelector("main[data-page=\"settings\"]", { timeout: 10_000 });
    await page.locator(".rail-row", { hasText: "Appearance" }).click();
    await page.locator("[data-theme-card=\"light\"]").waitFor({ timeout: 10_000 });
}

async function chooseTheme(app, choice) {
    await openAppearance(app);
    await page.locator(`[data-theme-card="${choice}"]`).click();
    await until(`the ${choice} theme`, async () => (await page.evaluate(() => document.documentElement.getAttribute("data-theme"))) === choice);
    await page.locator(".session-row").first().click();
    await page.locator(".code-card").first().waitFor({ timeout: 10_000 });
}

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port, "auto");
    const themes = join(trial.home, "machine", "desktop", "themes");
    mkdirSync(themes, { recursive: true });
    writeFileSync(join(themes, "crow-colors.json"), JSON.stringify({
        version: 1,
        slug: "crow-colors",
        name: "Crow Colors",
        type: "dark",
        source: "File crow-colors.json",
        colors: { surface: "#101820", "surface-code": "#0a0f14", "syntax-keyword": "#ff00ff", "syntax-comment": "#a0a0a0" },
        values: {},
        tokenColors: [],
        semanticTokenColors: {},
    }));

    const app = await trial.launch();
    page = await app.firstWindow();
    page.on("console", (message) => {
        if (/Refused to|Content Security Policy/.test(message.text())) refused.push(message.text());
    });
    await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: 45_000 });
    await trial.waitForHost();

    const input = page.locator(".composer-input");
    const send = page.locator(".send-button");
    await input.fill("Write the nest code");
    await input.press("Enter");
    await page.waitForSelector("[data-session][data-phase=\"attached\"]", { timeout: 45_000 });

    // The fence is open: the block shows its text and nothing is colored, however many flushes pass.
    await fenceOpen.promise;
    const cards = page.locator(".code-card");
    await cards.first().locator(".code-body", { hasText: "return `landed on" }).waitFor({ timeout: 15_000 });
    await pause(1_200);
    expectEqual(await cards.count(), 1, "the blocks while the fence is open");
    expectEqual(await cards.first().locator("[class^=\"tok-\"]").count(), 0, "colored runs while the fence is open");
    if (await page.locator(".live-status").count() !== 1) throw new Error("The turn was not still running.");

    // The closing fence arrives and the block is colored while the reply is still streaming.
    fenceClosed.resolve();
    await cards.first().locator(".tok-keyword").first().waitFor({ timeout: 15_000 });
    if (await page.locator(".live-status").count() !== 1) throw new Error("The reply ended before the block was colored.");
    await cards.nth(1).waitFor({ timeout: 10_000 });
    await pause(1_000);
    expectEqual(await cards.nth(1).locator("[class^=\"tok-\"]").count(), 0, "colored runs in a language with no grammar");
    expectEqual(await cards.nth(1).locator(".code-lang").innerText(), "nest", "the unknown language label");

    await until("the reply to end", async () => (await send.getAttribute("data-mode")) === "send", 60_000);
    await cards.nth(2).locator("[class^=\"tok-\"]").first().waitFor({ timeout: 15_000 });
    expectEqual(await cards.count(), 3, "the blocks after the reply");

    // Each kind of token has a class, and the text of the block is unchanged.
    const ts = cards.first();
    expectEqual(await ts.locator(".tok-keyword").first().innerText(), "const", "the first keyword");
    if (!(await ts.locator(".tok-comment").first().innerText()).includes("// caw")) throw new Error("The comment was not colored.");
    expectEqual(await ts.locator(".tok-number").first().innerText(), "1", "the number");
    expectEqual(await ts.locator(".tok-function").first().innerText(), "land", "the function name");
    if (!(await ts.locator(".tok-string").first().innerText()).includes("landed on")) throw new Error("The template string was not colored.");
    expectEqual(await ts.locator(".code-body").evaluate((element) => element.textContent), TS_CODE, "the block text");
    expectEqual(await ts.locator(".code-lang").innerText(), "ts", "the language label");

    // Dark theme colors come from the theme's syntax tokens.
    expectEqual(await colorOf(ts.locator(".tok-keyword")), "rgb(199, 146, 234)", "the dark keyword color");
    expectEqual(await colorOf(ts.locator(".tok-comment")), "rgb(127, 135, 148)", "the dark comment color");

    // Copy gives the plain code. The page's clipboard is replaced so the machine's own is untouched.
    await page.evaluate(() => {
        globalThis.copied = [];
        Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text) => { globalThis.copied.push(text); } }, configurable: true });
    });
    await ts.locator("button[title=\"Copy\"]").click();
    await until("the copy", async () => (await page.evaluate(() => globalThis.copied.length)) === 1);
    expectEqual((await page.evaluate(() => globalThis.copied))[0], TS_CODE, "the copied text");

    // The colors follow the theme, light and an imported one.
    await chooseTheme(app, "light");
    expectEqual(await colorOf(page.locator(".code-card .tok-keyword")), "rgb(138, 63, 176)", "the light keyword color");
    await chooseTheme(app, "imported:crow-colors");
    expectEqual(await colorOf(page.locator(".code-card .tok-keyword")), "rgb(255, 0, 255)", "the imported keyword color");
    expectEqual(await colorOf(page.locator(".code-card .tok-comment")), "rgb(160, 160, 160)", "the imported comment color");
    // A kind the imported theme leaves out takes the built-in color for its type.
    expectEqual(await colorOf(page.locator(".code-card .tok-number")), "rgb(217, 160, 91)", "the imported number color");

    // A finished reply is colored when its session opens again.
    await app.close();
    const again = await trial.launch();
    page = await again.firstWindow();
    await page.waitForSelector(".app", { timeout: 45_000 });
    await page.locator(".session-row").first().click({ timeout: 45_000 });
    await page.locator(".code-card").first().locator(".tok-keyword").first().waitFor({ timeout: 30_000 });
    expectEqual(await page.locator(".code-card").nth(1).locator("[class^=\"tok-\"]").count(), 0, "colored runs in a language with no grammar after reopening");

    // A block far from the screen is plain text again, and is colored when it comes back.
    await page.locator(".composer-input").fill("Write the filler");
    await page.locator(".composer-input").press("Enter");
    const long = page.locator(".code-card");
    await long.nth(3).waitFor({ timeout: 45_000 });
    await until("the filler reply to end", async () => (await page.locator(".send-button").getAttribute("data-mode")) === "send", 60_000);
    const scroller = page.locator(".transcript-scroll").first();
    await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await long.nth(3).locator(".tok-keyword").first().waitFor({ timeout: 15_000 });
    await until("the first block to go back to plain text", async () => (await long.first().locator("[class^=\"tok-\"]").count()) === 0);
    expectEqual(await long.first().locator(".code-body").evaluate((element) => element.textContent), TS_CODE, "the far block text");
    await scroller.evaluate((element) => { element.scrollTop = 0; });
    await long.first().locator(".tok-keyword").first().waitFor({ timeout: 15_000 });
    await until("the last block to go back to plain text", async () => (await long.nth(3).locator("[class^=\"tok-\"]").count()) === 0);

    if (refused.length > 0) throw new Error(`The page refused a script: ${refused[0]}`);
    console.log("codehl e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    console.error("Provider saw:", requests);
    if (refused.length > 0) console.error("Refused:", refused);
    if (page !== undefined) console.error("Page text:", await page.locator(".transcript-scroll, .app").first().innerText().catch(() => "unreadable"));
} finally {
    fenceOpen.resolve();
    fenceClosed.resolve();
    await trial.cleanup();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
}
process.exit(failed ? 1 : 0);
