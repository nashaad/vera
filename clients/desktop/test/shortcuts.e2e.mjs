// Shortcut test for the desktop shell. Run with: node clients/desktop/test/shortcuts.e2e.mjs
// It presses every native shortcut through the main process and checks what each one does.

import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NATIVE_SHORTCUTS } from "../../ui/src/commands/keys.ts";
import { configureFauxHome, streamChunk } from "./faux-home.mjs";
import { MODIFIER, press, startTrial } from "./trial.mjs";

const REPLY = "Crows sail past the reef.";
const TIMEOUT = 5_000;
const LONG_TIMEOUT = 45_000;

const KEY_NAMES = { BracketLeft: "[", BracketRight: "]", Comma: ",", Slash: "/" };

const PANE_ONE = "One Pane";
const PANE_BESIDE = "Subagent Beside";

const commandsOverlay = ".palette[data-overlay=\"palette\"]";
const sessionsOverlay = ".palette[data-overlay=\"sessions\"]";
const shortcutsOverlay = ".overlay-sheet[data-overlay=\"shortcuts\"]";
const paneItems = "[role=\"menuitemcheckbox\"]";

function locationOf(name) {
    return `[data-location="${name}"]`;
}

function keyFor(code) {
    const letter = /^Key([A-Z])$/.exec(code);
    if (letter !== null) return letter[1];
    if (Object.hasOwn(KEY_NAMES, code)) return KEY_NAMES[code];
    throw new Error(`No key is mapped for the code ${code}.`);
}

function modifiersFor(shortcut) {
    return [MODIFIER, ...(shortcut.alt ? ["alt"] : []), ...(shortcut.shift ? ["shift"] : [])];
}

async function settle(page, selector, open) {
    await page.waitForSelector(selector, { state: open ? "attached" : "detached", timeout: TIMEOUT });
}

// Presses the shortcut to flip a part of the window, then again to put it back.
async function flip(page, selector, tap) {
    const wasOpen = await page.locator(selector).count() > 0;
    await tap();
    await settle(page, selector, !wasOpen);
    await tap();
    await settle(page, selector, wasOpen);
}

async function showMain(page, name) {
    await page.waitForSelector(`main[data-page="${name}"]`, { timeout: TIMEOUT });
}

async function leavesPage(page, name) {
    await page.waitForFunction((expected) => {
        const main = document.querySelector("main[data-page]");
        return main !== null && main.dataset.page !== expected;
    }, name, { timeout: TIMEOUT });
}

async function goTo(page, name) {
    await page.click(`.nav-row[data-page="${name}"]`);
    await showMain(page, name);
}

async function overlay(ctx, tap, selector) {
    await tap();
    await ctx.page.waitForSelector(selector, { timeout: TIMEOUT });
    await press(ctx.app, "Escape");
    await settle(ctx.page, selector, false);
}

// Back needs a page to return to, so the forward check goes back first.
async function checkBack(ctx, tap) {
    await goTo(ctx.page, "work");
    await tap();
    await leavesPage(ctx.page, "work");
}

async function checkForward(ctx, tap) {
    await goTo(ctx.page, "work");
    await ctx.back();
    await leavesPage(ctx.page, "work");
    await tap();
    await showMain(ctx.page, "work");
}

// The palette's session rows carry the session id that the session page is keyed by.
async function openSession(ctx) {
    await press(ctx.app, "P", [MODIFIER]);
    await ctx.page.waitForSelector(sessionsOverlay, { timeout: TIMEOUT });
    await ctx.page.click(`${sessionsOverlay} [data-session="${ctx.agentId}"]`);
    await showMain(ctx.page, "session");
}

// The session menu closes on Escape only while it holds focus.
async function paneLabel(ctx) {
    await ctx.page.click("[data-session-menu=\"true\"]");
    await ctx.page.waitForSelector(paneItems, { timeout: TIMEOUT });
    const checked = ctx.page.locator(`${paneItems}[aria-checked="true"]`);
    if (await checked.count() !== 1) throw new Error("The session menu does not check exactly one pane layout.");
    const label = (await checked.textContent()).trim();
    await press(ctx.app, "Escape");
    await settle(ctx.page, paneItems, false);
    return label;
}

async function expectPane(ctx, expected) {
    const label = await paneLabel(ctx);
    if (label !== expected) throw new Error(`The pane layout is "${label}", expected "${expected}".`);
}

async function checkCycle(ctx, tap) {
    await openSession(ctx);
    await expectPane(ctx, PANE_ONE);
    await tap();
    await expectPane(ctx, PANE_BESIDE);
    await tap();
    await tap();
    await expectPane(ctx, PANE_ONE);
}

const CHECKS = {
    "CmdOrCtrl+B": (ctx, tap) => flip(ctx.page, locationOf("sidebar"), tap),
    "CmdOrCtrl+Alt+B": (ctx, tap) => flip(ctx.page, locationOf("rightPane"), tap),
    "CmdOrCtrl+J": (ctx, tap) => flip(ctx.page, locationOf("panel"), tap),
    "CmdOrCtrl+N": async (ctx, tap) => {
        await goTo(ctx.page, "work");
        await tap();
        await showMain(ctx.page, "home");
    },
    "CmdOrCtrl+[": checkBack,
    "CmdOrCtrl+]": checkForward,
    "CmdOrCtrl+,": async (ctx, tap) => {
        await tap();
        await showMain(ctx.page, "settings");
    },
    "CmdOrCtrl+Alt+A": checkCycle,
    "CmdOrCtrl+K": (ctx, tap) => overlay(ctx, tap, commandsOverlay),
    "CmdOrCtrl+P": (ctx, tap) => overlay(ctx, tap, sessionsOverlay),
    "CmdOrCtrl+/": (ctx, tap) => overlay(ctx, tap, shortcutsOverlay),
    "CmdOrCtrl+Shift+P": (ctx, tap) => overlay(ctx, tap, commandsOverlay),
};

const accelerators = NATIVE_SHORTCUTS.map((shortcut) => shortcut.accelerator);
const unchecked = accelerators.filter((accelerator) => !Object.hasOwn(CHECKS, accelerator));
const unknown = Object.keys(CHECKS).filter((accelerator) => !accelerators.includes(accelerator));
if (unchecked.length > 0 || unknown.length > 0) {
    throw new Error(`Shortcut checks do not match the table. No check for: ${unchecked.join(", ") || "none"}. No shortcut for: ${unknown.join(", ") || "none"}.`);
}

const plan = NATIVE_SHORTCUTS.map((shortcut) => ({
    shortcut,
    key: keyFor(shortcut.code),
    modifiers: modifiersFor(shortcut),
}));

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
        for (const part of REPLY.split(/(?= )/)) response.write(streamChunk(body.model, { content: part }));
        response.write(`data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
        response.end("data: [DONE]\n\n");
    });
});

const trial = startTrial();
const ctx = {};
let failed = false;
let page;

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port);
    const folder = join(trial.home, "..", "work");
    mkdirSync(folder, { recursive: true });

    const app = await trial.launch();
    // The native folder picker is stubbed to return the work folder.
    await app.evaluate(({ dialog }, folderPath) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folderPath] });
    }, folder);

    page = await app.firstWindow();
    ctx.app = app;
    ctx.page = page;
    ctx.back = () => press(app, "[", [MODIFIER]);
    await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: LONG_TIMEOUT });
    await trial.waitForHost();

    await page.getByRole("button", { name: /No folder/ }).click();
    await page.getByRole("menuitem", { name: /Open folder/ }).click();
    await page.waitForSelector(".context-chips .chip-label:text-is(\"work\")");
    const input = page.locator(".composer-input");
    await input.fill("Hello crow");
    await input.press("Enter");
    await page.waitForSelector("[data-session][data-phase=\"attached\"]", { timeout: LONG_TIMEOUT });
    await page.waitForSelector(`text=${REPLY}`, { timeout: 30_000 });
    ctx.agentId = await page.locator(".transcript-scroll[data-session]").first().getAttribute("data-session");

    for (const item of plan) {
        const check = CHECKS[item.shortcut.accelerator];
        await check(ctx, () => press(app, item.key, item.modifiers));
        console.log(`${item.shortcut.accelerator}  ${item.shortcut.label}  passed`);
    }
    console.log("shortcuts e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    if (page !== undefined) {
        const shot = join(tmpdir(), `vera-shortcuts-${Date.now()}.png`);
        await page.screenshot({ path: shot }).then(
            () => console.error(`Screenshot: ${shot}`),
            () => console.error("No screenshot was taken."),
        );
    }
} finally {
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    await trial.cleanup();
}
process.exit(failed ? 1 : 0);
