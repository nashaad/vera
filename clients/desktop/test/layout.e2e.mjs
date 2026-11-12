// Layout test for the desktop shell. Run with: node clients/desktop/test/layout.e2e.mjs
// It moves a view and picks a theme, relaunches on the same trial home and checks both stayed.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { MODIFIER, press, startTrial } from "./trial.mjs";

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

// At the window's minimum width with both side panes open, the main area keeps its own column
// and the composer's controls sit side by side without covering each other.
async function assertNarrowFits(app, page) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 800));
    await page.waitForFunction(() => window.innerWidth <= 720, null, { timeout: 5_000 });
    const stage = await box(page, ".stage");
    const center = await box(page, ".center");
    const sidebar = await box(page, location("sidebar"));
    const pane = await box(page, location("rightPane"));
    if (sidebar.width < 159 || pane.width < 239) throw new Error(`A side pane went under its minimum: ${sidebar.width}, ${pane.width}.`);
    if (center.x + center.width > stage.x + stage.width + 1) throw new Error("The main area spills out of its column.");
    if (stage.x + stage.width > pane.x + 1) throw new Error("The main area runs under the right pane.");
    const bar = await box(page, ".composer-bar");
    const controls = await page.locator(".composer-bar :is(.round-button, .pill-button, .send-button)").evaluateAll((nodes) =>
        nodes.map((node) => node.getBoundingClientRect()).map((rect) => ({ left: rect.left, right: rect.right })));
    controls.sort((a, b) => a.left - b.left);
    for (let index = 1; index < controls.length; index += 1) {
        if (controls[index].left < controls[index - 1].right - 0.5) throw new Error("Two composer controls overlap.");
    }
    if (controls.some((control) => control.left < bar.x - 0.5 || control.right > bar.x + bar.width + 0.5)) {
        throw new Error("A composer control spills out of the composer.");
    }
    // A pill shrinks before its text does, so the text has to stay inside its own pill.
    const spilled = await page.locator(".composer-bar .pill-button :is(.pill-label, .pill-sub)").evaluateAll((labels) =>
        labels.filter((label) => label.getClientRects().length > 0).filter((label) => {
            const inner = label.getBoundingClientRect();
            const outer = label.closest(".pill-button").getBoundingClientRect();
            return inner.left < outer.left - 0.5 || inner.right > outer.right + 0.5;
        }).map((label) => label.textContent));
    if (spilled.length > 0) throw new Error(`Pill text runs out of its pill: ${spilled.join(", ")}.`);
    // Short of room, the approval pill keeps only its icon and then the effort pill goes, so the
    // model's name is cut short only once both have given way.
    const fit = await composerFit(page);
    if (fit === undefined) throw new Error("The composer bar has no fit.");
    const approvalText = await page.locator(".composer-bar .approval-picker .pill-button").innerText();
    if ((fit === "full") !== (approvalText.trim() !== "")) throw new Error(`The approval pill shows "${approvalText}" at fit ${fit}.`);
    const modelCut = await page.locator(".composer-bar .model-pill .pill-label").evaluate((label) => label.scrollWidth > label.clientWidth);
    if (modelCut && fit !== "tight") throw new Error(`The model name is cut short at fit ${fit}.`);
    if (fit === "tight" && await page.locator(".composer-bar .effort-picker").isVisible()) throw new Error("The effort pill shows at fit tight.");
    const approvalTitle = await page.locator(".composer-bar .approval-picker .pill-button").getAttribute("title");
    const approvalLabel = await page.locator(".composer-bar .approval-picker .pill-label").evaluate((label) => label.textContent);
    if (approvalTitle.split("\n")[0] !== approvalLabel) throw new Error(`The approval pill's title does not name the mode: ${approvalTitle}.`);

    // Each popover opens whole: no pane covers or clips it and it stays inside the window.
    const popovers = [
        [".composer-bar .approval-picker .pill-button", ".approval-menu"],
        [".composer-bar .model-pill", ".model-menu"],
        [".context-chips .folder-picker .chip-button", ".folder-menu"],
    ];
    for (const [pill, popover] of popovers) {
        await page.locator(pill).first().click();
        await page.waitForSelector(popover, { timeout: 5_000 });
        const hidden = await page.locator(popover).evaluate((node) => {
            const rect = node.getBoundingClientRect();
            const corners = [[rect.left + 4, rect.top + 4], [rect.right - 4, rect.top + 4], [rect.left + 4, rect.bottom - 4], [rect.right - 4, rect.bottom - 4]];
            return corners.some(([x, y]) => !node.contains(document.elementFromPoint(x, y)));
        });
        await page.keyboard.press("Escape");
        await page.waitForSelector(popover, { state: "detached", timeout: 5_000 });
        if (hidden) throw new Error(`${popover} is cut off at the narrow width.`);
    }

    // With room again, every pill comes back.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 800));
    await page.waitForFunction(() => document.querySelector(".composer-bar")?.dataset.fit === "full", null, { timeout: 5_000 })
        .catch(async () => { throw new Error(`The composer bar stays at fit ${await composerFit(page)} in a wide window.`); });
}

async function composerFit(page) {
    return page.locator(".composer-bar").evaluate((bar) => bar.dataset.fit);
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

    // With its only view moved out, the sidebar still shows its page rows, and both toggles work.
    const modifier = MODIFIER;
    const sidebarRows = `${location("sidebar")} .nav-row`;
    await second.page.waitForSelector(sidebarRows, { timeout: 5_000 });
    await press(second.app, "B", [modifier]);
    await second.page.waitForSelector(location("sidebar"), { state: "detached", timeout: 5_000 });
    await second.page.click(".titlebar [data-header-toggle=\"sidebar\"]");
    await second.page.waitForSelector(sidebarRows, { timeout: 5_000 });
    await second.page.click(`${location("sidebar")} [data-header-toggle="sidebar"]`);
    await second.page.waitForSelector(location("sidebar"), { state: "detached", timeout: 5_000 });
    await press(second.app, "B", [modifier]);
    await second.page.waitForSelector(sidebarRows, { timeout: 5_000 });

    await second.page.click(`${sessionsHeader} .icon-button`);
    await second.page.getByRole("menuitem", { name: "Reset Location" }).click();
    await assertIn(second.page, "sidebar");

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

    await press(second.app, "B", [modifier, "alt"]);
    await second.page.waitForSelector(location("rightPane"), { timeout: 5_000 });
    await assertNarrowFits(second.app, second.page);

    console.log(`layout e2e passed: ${trial.home}`);
} finally {
    await trial.cleanup();
}
