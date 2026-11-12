// Layout test for the desktop shell. Run with: node clients/desktop/test/layout.e2e.mjs
// It moves a view and picks a theme, relaunches on the same trial home and checks both stayed.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { startTrial } from "./trial.mjs";

const trial = startTrial();
const sessionsHeader = "[data-view-header=\"core.sessions\"]";

function location(name) {
    return `[data-location="${name}"]`;
}

async function boot(expected) {
    const app = await trial.launch();
    const page = await app.firstWindow();
    await page.waitForSelector(`${location(expected)} ${sessionsHeader}`, { timeout: 45_000 });
    // The lock names a launcher before the real host, so wait for the page to attach first.
    await page.waitForSelector(".app[data-sessions]", { timeout: 45_000 });
    await trial.waitForHost();
    return { app, page };
}

async function box(page, selector) {
    const found = await page.locator(selector).first().boundingBox();
    if (found === null) throw new Error(`${selector} has no box`);
    return found;
}

async function dragSessionsToPanel(page) {
    const source = await box(page, sessionsHeader);
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(source.x + source.width / 2 + 12, source.y + source.height / 2 + 12, { steps: 4 });
    await page.waitForSelector("[data-drop-zone=\"panel\"]", { timeout: 5_000 });
    const strip = await box(page, "[data-drop-zone=\"panel\"]");
    await page.mouse.move(strip.x + strip.width / 2, strip.y + strip.height / 2, { steps: 8 });
    await page.mouse.up();
}

async function assertIn(page, name, header = sessionsHeader) {
    await page.waitForSelector(`${location(name)} ${header}`, { timeout: 10_000 });
}

async function press(app, key, modifiers) {
    await app.evaluate(({ BrowserWindow }, { key, modifiers }) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        contents.sendInputEvent({ type: "keyDown", keyCode: key, modifiers });
        contents.sendInputEvent({ type: "keyUp", keyCode: key, modifiers });
    }, { key, modifiers });
}

async function theme(page) {
    return page.evaluate(() => document.documentElement.getAttribute("data-theme"));
}

async function chooseTheme(app, command) {
    await app.evaluate(({ Menu }, id) => {
        Menu.getApplicationMenu().getMenuItemById(id).click();
    }, command);
}

async function waitForCheckedTheme(app, command) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const checked = await app.evaluate(({ Menu }, id) => (
            Menu.getApplicationMenu().getMenuItemById(id).checked
        ), command);
        if (checked) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`The View menu never checked ${command}.`);
}

async function waitForSaved() {
    const path = join(trial.home, "machine", "desktop", "layout.json");
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (existsSync(path) && readFileSync(path, "utf8").includes("core.sessions")) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`The layout was not saved at ${path}`);
}

try {
    const first = await boot("sidebar");
    // The right pane starts closed; Cmd+Alt+B and the layout command open it.
    if (await first.page.locator(location("rightPane")).count() > 0) {
        throw new Error("The right pane is open in the default layout.");
    }
    if (await theme(first.page) !== "dark") throw new Error("The first launch is not dark.");
    await waitForCheckedTheme(first.app, "theme.dark");
    await dragSessionsToPanel(first.page);
    await assertIn(first.page, "panel");
    await chooseTheme(first.app, "theme.light");
    await waitForCheckedTheme(first.app, "theme.light");
    await waitForSaved();
    await first.app.close();

    const second = await boot("panel");
    if (await theme(second.page) !== "light") throw new Error("The theme was not remembered across the relaunch.");
    await waitForCheckedTheme(second.app, "theme.light");
    if (await second.page.locator(`${location("sidebar")} ${sessionsHeader}`).count() > 0) {
        throw new Error("Sessions is in the sidebar after the relaunch.");
    }

    await second.page.click(`${sessionsHeader} .icon-button`);
    await second.page.getByRole("menuitem", { name: "Reset Location" }).click();
    await assertIn(second.page, "sidebar");

    const modifier = process.platform === "darwin" ? "meta" : "control";
    await press(second.app, "B", [modifier]);
    await second.page.waitForSelector(location("sidebar"), { state: "detached", timeout: 5_000 });
    await press(second.app, "B", [modifier]);
    await second.page.waitForSelector(location("sidebar"), { timeout: 5_000 });

    await press(second.app, "B", [modifier, "alt"]);
    await second.page.waitForSelector(location("rightPane"), { timeout: 5_000 });
    await press(second.app, "B", [modifier, "alt"]);
    await second.page.waitForSelector(location("rightPane"), { state: "detached", timeout: 5_000 });
    await second.page.click(".titlebar [data-header-toggle=\"rightPane\"]");
    await second.page.waitForSelector(location("rightPane"), { timeout: 5_000 });
    await second.page.click(".titlebar [data-header-toggle=\"rightPane\"]");
    await second.page.waitForSelector(location("rightPane"), { state: "detached", timeout: 5_000 });

    // The panel was revealed by the drop; its toggle hides it and shows it again.
    await press(second.app, "J", [modifier]);
    await second.page.waitForSelector(location("panel"), { state: "detached", timeout: 5_000 });
    await press(second.app, "J", [modifier]);
    await second.page.waitForSelector(location("panel"), { timeout: 5_000 });

    // A container moves through its own menu; the View menu's Reset Layout undoes it.
    const outputHeader = "[data-view-header=\"core.output\"]";
    const activity = "[data-switcher=\"panel\"] [data-container=\"core.output\"]";
    await second.page.click(activity, { button: "right" });
    await second.page.getByRole("menuitem", { name: "Move to Right Pane" }).click();
    await assertIn(second.page, "rightPane", outputHeader);
    await second.app.evaluate(({ Menu }) => {
        Menu.getApplicationMenu().getMenuItemById("layout.reset").click();
    });
    await second.page.waitForSelector(`${location("rightPane")} ${outputHeader}`, { state: "detached", timeout: 10_000 });
    await assertIn(second.page, "sidebar");

    // The sidebar's page rows switch the main area; Cmd+[ and Cmd+] walk back and forward.
    await second.page.click(".nav-row[data-page=\"work\"]");
    await second.page.waitForSelector("main[data-page=\"work\"]", { timeout: 5_000 });
    await press(second.app, "[", [modifier]);
    await second.page.waitForSelector("main[data-page=\"home\"]", { timeout: 5_000 });
    await press(second.app, "]", [modifier]);
    await second.page.waitForSelector("main[data-page=\"work\"]", { timeout: 5_000 });
    await press(second.app, "N", [modifier]);
    await second.page.waitForSelector("main[data-page=\"home\"]", { timeout: 5_000 });

    console.log(`layout e2e passed: ${trial.home}`);
} finally {
    await trial.cleanup();
}
