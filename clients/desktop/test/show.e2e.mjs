// Show test for the desktop shell. Run with: node clients/desktop/test/show.e2e.mjs
// Settings > Show turns parts of the window on and off: the sidebar, the palette and the native menu follow,
// the choice reaches flags.json beside the keys the desktop does not know, and it survives a relaunch.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { until } from "./faux-home.mjs";
import { MODIFIER, press, startTrial } from "./trial.mjs";

const trial = startTrial();
// A key the desktop has no flag for stays in the file when a choice is saved.
trial.writeFlags({ mystery: "kept" });

const flagsFile = join(trial.home, "machine", "desktop", "flags.json");

function onDisk() {
    try {
        return JSON.parse(readFileSync(flagsFile, "utf8"));
    } catch {
        return {};
    }
}

function group(page, name) {
    return page.locator(`[role="group"][aria-label="${name}"]`);
}

async function offered(page, name) {
    return group(page, name).locator("button").allInnerTexts();
}

async function pressed(page, name) {
    return group(page, name).locator("button[aria-pressed=\"true\"]").innerText();
}

async function expectOffered(page, name, expected, current) {
    const labels = await offered(page, name);
    if (labels.join(",") !== expected.join(",")) throw new Error(`${name} offers ${labels.join(", ")}, expected ${expected.join(", ")}.`);
    const value = await pressed(page, name);
    if (value !== current) throw new Error(`${name} is ${value}, expected ${current}.`);
}

async function choose(page, name, choice) {
    await group(page, name).getByRole("button", { name: choice, exact: true }).click();
}

async function menuHas(app, id) {
    return app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId) != null, id);
}

async function paletteHas(app, page, query, command) {
    await press(app, "K", [MODIFIER]);
    const palette = page.locator("input[aria-label=\"Command palette\"]");
    await palette.waitFor({ timeout: 10_000 });
    await palette.fill(query);
    await page.waitForTimeout(300);
    const found = await page.locator(`.palette-row[data-command="${command}"]`).count() > 0;
    await page.keyboard.press("Escape");
    await page.locator("[data-overlay=\"palette\"]").waitFor({ state: "detached", timeout: 10_000 });
    return found;
}

async function expectGone(page, selector, what) {
    await page.waitForSelector(selector, { state: "detached", timeout: 10_000 }).catch(() => {
        throw new Error(`${what} stayed in the window.`);
    });
}

async function boot() {
    const app = await trial.launch();
    const page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: 45_000 });
    await trial.waitForHost();
    return { app, page };
}

async function openShow(app, page) {
    await press(app, ",", [MODIFIER]);
    await page.waitForSelector("main[data-page=\"settings\"]", { timeout: 10_000 });
    await page.locator(".rail-row").filter({ has: page.getByText("Show", { exact: true }) }).click();
    await page.locator("h1", { hasText: "Show" }).waitFor({ timeout: 10_000 });
}

const work = ".nav-row[data-page=\"work\"]";
const devices = ".sidebar-foot [data-page=\"devices\"]";

try {
    const first = await boot();
    const { app, page } = first;

    // Under Auto a window with no sessions shows no Search, Work or Customize; New Chat is always there.
    await page.waitForSelector(".nav-row[data-page=\"home\"]", { timeout: 10_000 });
    for (const kind of ["search", "work", "customize"]) {
        if (await page.locator(`.nav-row[data-page="${kind}"]`).count() > 0) throw new Error(`${kind} shows before it has anything to show.`);
    }
    await page.waitForSelector(devices, { timeout: 10_000 });
    if (await menuHas(app, "go.work")) throw new Error("The Go menu offers Work while it is hidden.");
    if (await paletteHas(app, page, "work", "go.work")) throw new Error("The palette offers Work while it is hidden.");

    await openShow(app, page);
    await expectOffered(page, "Work", ["Auto", "On", "Off"], "Auto");
    await expectOffered(page, "Search", ["Auto", "On", "Off"], "Auto");
    await expectOffered(page, "Browser", ["On", "Off"], "On");
    await expectOffered(page, "Reasoning", ["On", "Off"], "Off");
    await expectOffered(page, "Devices", ["On", "Off"], "On");
    await expectOffered(page, "Tour", ["On", "Off"], "On");
    await expectOffered(page, "Host build", ["On", "Off"], "On");

    // On puts the entries in every place that offers them, and the file keeps the unknown key.
    await choose(page, "Work", "On");
    await until("work in flags.json", async () => onDisk().work === "on", 10_000);
    if (onDisk().mystery !== "kept") throw new Error("Saving a choice dropped a key the desktop does not know.");
    await page.waitForSelector(work, { timeout: 10_000 });
    await until("Work in the Go menu", () => menuHas(app, "go.work"), 10_000);
    if (!await paletteHas(app, page, "work", "go.work")) throw new Error("The palette does not offer Work after it was turned on.");

    // Off takes them away again.
    await choose(page, "Work", "Off");
    await expectGone(page, work, "The Work entry");
    await until("Work gone from the Go menu", async () => !await menuHas(app, "go.work"), 10_000);
    if (await paletteHas(app, page, "work", "go.work")) throw new Error("The palette still offers Work after it was turned off.");

    await choose(page, "Devices", "Off");
    await expectGone(page, devices, "The Devices button");
    await choose(page, "Reasoning", "On");
    await until("the choices in flags.json", async () => {
        const saved = onDisk();
        return saved.work === "off" && saved.devices === "off" && saved.showReasoning === "on";
    }, 10_000);

    await app.close();

    // The next launch reads the same file.
    const second = await boot();
    await second.page.waitForSelector(".nav-row[data-page=\"home\"]", { timeout: 10_000 });
    await expectGone(second.page, devices, "The Devices button after the relaunch");
    await expectGone(second.page, work, "The Work entry after the relaunch");
    await openShow(second.app, second.page);
    await expectOffered(second.page, "Work", ["Auto", "On", "Off"], "Off");
    await expectOffered(second.page, "Devices", ["On", "Off"], "Off");
    await expectOffered(second.page, "Reasoning", ["On", "Off"], "On");

    console.log("show e2e passed");
} finally {
    await trial.cleanup();
}
