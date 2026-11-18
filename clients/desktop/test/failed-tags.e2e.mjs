import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { startTrial } from "./trial.mjs";

const ANSWER = "The crow could not find the map.";
const FILE = "the-pirate-crows-missing-treasure-map.txt";
const COMMAND = "printf 'No map aboard\\n'; exit 1";
const requests = [];

function stepFor(messages) {
    const lastUser = messages.findLastIndex((message) => message.role === "user");
    const results = messages.slice(lastUser + 1).filter((message) => message.role === "tool").length;
    if (results === 0) return { name: "read", input: { path: FILE } };
    if (results === 1) return { name: "bash", input: { command: COMMAND } };
    return undefined;
}

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
        const messages = body.messages ?? [];
        requests.push({ role: messages.at(-1)?.role, stream: body.stream });
        if (body.stream === false) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({
                id: "reply", model: body.model,
                choices: [{ index: 0, message: { role: "assistant", content: "Crow" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
            }));
            return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        const step = stepFor(messages);
        if (step === undefined) {
            response.write(streamChunk(body.model, { role: "assistant", content: ANSWER }, "stop"));
        } else {
            const call = { index: 0, id: `call-${step.name}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.input) } };
            response.write(streamChunk(body.model, { role: "assistant", tool_calls: [call] }, "tool_calls"));
        }
        response.end("data: [DONE]\n\n");
    });
});

const trial = startTrial();
const screenshots = process.env.VERA_FAILED_TAG_SHOTS;
let failed = false;
let page;
let hostPid;
let appPid;

function isRunning(pid) {
    if (pid === undefined) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error.code === "ESRCH") return false;
        throw error;
    }
}

async function checkLabel(locator, theme) {
    const style = await locator.evaluate((label) => {
        const root = getComputedStyle(document.documentElement);
        const resolved = (token) => {
            const probe = document.createElement("span");
            probe.style.color = root.getPropertyValue(token).trim();
            document.body.append(probe);
            const color = getComputedStyle(probe).color;
            probe.remove();
            return color;
        };
        const own = getComputedStyle(label);
        const dot = getComputedStyle(label, "::before");
        return {
            color: own.color, muted: resolved("--vera-text-muted"),
            dot: dot.color, danger: resolved("--vera-danger"), content: dot.content,
            border: own.borderTopWidth, radius: own.borderTopLeftRadius,
            whitespace: own.whiteSpace, shrink: own.flexShrink,
        };
    });
    if (style.color !== style.muted || style.dot !== style.danger || style.content !== '"•"'
        || style.border !== "0px" || style.radius !== "0px" || style.whitespace !== "nowrap" || style.shrink !== "0") {
        throw new Error(`${theme} failure label styles: ${JSON.stringify(style)}`);
    }
}

async function capture(theme, state) {
    if (screenshots === undefined) return;
    mkdirSync(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, `${theme}-${state}.png`), animations: "disabled" });
}

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port, "auto");
    const folder = join(trial.home, "..", "work");
    mkdirSync(folder, { recursive: true });

    const app = await trial.launch();
    appPid = app.process().pid;
    await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, folder);
    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: 45_000 });
    hostPid = await trial.waitForHost();
    console.log(`trial root=${trial.trialRoot} electron=${appPid} host=${hostPid}`);

    await page.getByRole("button", { name: /No folder/ }).click();
    await page.getByRole("menuitem", { name: /Open folder/ }).click();
    await page.waitForSelector(".context-chips .chip-label:text-is(\"work\")");
    const input = page.locator(".composer-input");
    await input.fill("Find the pirate crow's map");
    await input.press("Enter");
    await page.waitForSelector(`text=${ANSWER}`, { timeout: 60_000 });
    await until("the turn to finish", async () => (await page.locator(".send-button").getAttribute("data-mode")) === "send");

    const run = page.locator(".run");
    const head = run.locator(".run-head");
    if (await head.locator(".failed-tag").innerText() !== "2 failed") throw new Error("The run did not count both failures.");

    for (const [theme, command] of [["dark", "theme.dark"], ["light", "theme.light"], ["high-contrast", "theme.highContrast"]]) {
        await app.evaluate(({ Menu }, id) => Menu.getApplicationMenu().getMenuItemById(id).click(), command);
        await until(`${theme} theme`, async () => (await page.locator("html").getAttribute("data-theme")) === theme);
        await checkLabel(head.locator(".failed-tag"), theme);
        if (theme !== "high-contrast") await capture(theme, "collapsed");

        await head.click();
        const rows = run.locator(".call-row[data-failed=\"true\"]");
        if (await rows.count() !== 2) throw new Error(`${theme} did not show two failed rows.`);
        for (let index = 0; index < 2; index += 1) {
            if (await rows.nth(index).locator(".failed-tag").innerText() !== "failed") throw new Error("A row lost its failed text.");
            await checkLabel(rows.nth(index).locator(".failed-tag"), theme);
            const colors = await rows.nth(index).locator(".arg").evaluate((arg) => ({
                target: getComputedStyle(arg).color,
                line: getComputedStyle(arg.closest(".call-line")).color,
            }));
            if (colors.target !== colors.line) throw new Error(`${theme} target has a separate failure color: ${JSON.stringify(colors)}`);
        }
        if (theme !== "high-contrast") await capture(theme, "expanded");

        await rows.nth(0).locator(".call-line").click();
        await rows.nth(0).locator(".call-out").waitFor({ timeout: 5_000 });
        await rows.nth(1).locator(".call-line").click();
        const output = await rows.nth(1).locator(".shell-out").innerText();
        if (!output.includes("No map aboard")) throw new Error(`Shell output was ${JSON.stringify(output)}`);
        await rows.nth(0).locator(".call-line").click();
        await rows.nth(1).locator(".call-line").click();

        const layout = await run.evaluate((element) => {
            element.style.width = "210px";
            const head = element.querySelector(".run-head");
            const title = head.querySelector(".t");
            const tag = head.querySelector(".failed-tag");
            const chevron = head.querySelector(".chev");
            const line = element.querySelector(".call-line");
            const target = line.querySelector(".arg");
            const rowTag = line.querySelector(".failed-tag");
            const within = (child, parent) => child.getBoundingClientRect().right <= parent.getBoundingClientRect().right + 0.5;
            const result = {
                titleTruncated: title.scrollWidth > title.clientWidth,
                targetTruncated: target.scrollWidth > target.clientWidth,
                chevronInside: within(chevron, head), tagInside: within(tag, head), rowTagInside: within(rowTag, line),
                titleEllipsis: getComputedStyle(title).textOverflow, targetEllipsis: getComputedStyle(target).textOverflow,
            };
            element.style.removeProperty("width");
            return result;
        });
        if (!layout.titleTruncated || !layout.targetTruncated || !layout.chevronInside || !layout.tagInside || !layout.rowTagInside
            || layout.titleEllipsis !== "ellipsis" || layout.targetEllipsis !== "ellipsis") {
            throw new Error(`${theme} narrow layout: ${JSON.stringify(layout)}`);
        }
        await head.click();
        console.log(`${theme}: labels, output and narrow layout passed`);
    }
    console.log("failed tags e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    console.error("Provider saw:", requests);
    if (page !== undefined) console.error("Page text:", await page.locator(".transcript-scroll, .app").first().innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    try {
        await until("trial processes to exit", () => !isRunning(appPid) && !isRunning(hostPid), 10_000);
        console.log(`trial processes exited: electron=${appPid} host=${hostPid}`);
    } catch (error) {
        failed = true;
        console.error(error);
    }
}
process.exit(failed ? 1 : 0);
