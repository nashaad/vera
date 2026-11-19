import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";

import { configureFauxHome, until } from "./faux-home.mjs";
import { MODIFIER, press, startTrial, waitForAnnexPages } from "./trial.mjs";

const exec = promisify(execFile);
const provider = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "crow-0" }] }));
});
const site = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>Notice fixture</title><p>Browser notice fixture</p>");
});
const trial = startTrial();
let page;
let failed = false;

async function externalSetting(enabled) {
    const { socket_path: socket } = JSON.parse(readFileSync(join(trial.home, "runtime", "host.json"), "utf8"));
    const script = `import { requestExtensionThroughHost } from "./src/host/extension-request-client.ts";
        await requestExtensionThroughHost(process.argv[1], "vera.desktop-browser", "settings", { enabled: process.argv[2] === "true" }, AbortSignal.timeout(5000));`;
    await exec("bun", ["-e", script, socket, String(enabled)], { cwd: trial.root, timeout: 10_000 });
}

try {
    await Promise.all([provider, site].map((server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))));
    configureFauxHome(trial.home, provider.address().port);
    const app = await trial.launch();
    page = await app.firstWindow();
    await page.waitForSelector('.app[data-sessions="0"]', { timeout: 45_000 });
    await trial.waitForHost();
    await waitForAnnexPages(page, app);

    const notice = page.locator(".browser-tools-notice");
    const composer = page.locator(".composer-input");
    const action = notice.getByRole("button", { name: "Turn off" });
    if (await notice.count() !== 0) throw new Error("Notice appeared while Browser tools were off.");

    async function selectTheme(theme) {
        await app.evaluate(({ Menu }, name) => {
            const item = Menu.getApplicationMenu().getMenuItemById(`theme.${name}`);
            if (item === null) throw new Error(`No theme menu item for ${name}.`);
            item.click();
        }, theme);
        await until(`${theme} theme applied`, () => page.evaluate((name) => document.documentElement.getAttribute("data-theme") === name, theme));
        await page.mouse.move(0, 0);
    }

    async function style(locator) {
        return locator.evaluate((element) => {
            const css = getComputedStyle(element);
            return {
                height: css.height,
                fontSize: css.fontSize,
                borderRadius: css.borderRadius,
                borderStyle: css.borderStyle,
                borderColor: css.borderColor,
                background: css.backgroundColor,
                color: css.color,
                cursor: css.cursor,
                outlineStyle: css.outlineStyle,
                outlineWidth: css.outlineWidth,
                outlineColor: css.outlineColor,
                focusVisible: element.matches(":focus-visible"),
            };
        });
    }

    async function enabledAppearance(theme) {
        await selectTheme(theme);
        const folder = page.locator(".context-chips .chip-button").first();
        await until(`${theme} notice settled`, async () => {
            const actual = await style(action);
            const neighbour = await style(folder);
            return actual.background === neighbour.background && actual.color === neighbour.color && actual.borderColor === neighbour.borderColor;
        });
        const normal = await style(action);
        const neighbour = await style(folder);
        for (const key of ["height", "fontSize", "borderRadius", "borderStyle", "borderColor", "background", "color"]) {
            if (normal[key] !== neighbour[key]) throw new Error(`${theme}: notice ${key} ${normal[key]} differs from folder chip ${neighbour[key]}.`);
        }
        const hoverColor = await page.evaluate(() => {
            const probe = document.createElement("span");
            probe.style.backgroundColor = "var(--vera-surface-hover)";
            document.body.append(probe);
            const color = getComputedStyle(probe).backgroundColor;
            probe.remove();
            return color;
        });
        await action.hover();
        await until(`${theme} notice hover`, async () => (await style(action)).background === hoverColor);
        const hovered = await style(action);
        if (hovered.background === normal.background) throw new Error(`${theme}: notice hover is unchanged.`);
        await folder.hover();
        await until(`${theme} folder hover`, async () => (await style(folder)).background === hoverColor);
        const folderHover = await style(folder);
        for (const key of ["background", "color", "borderColor"]) {
            if (hovered[key] !== folderHover[key]) throw new Error(`${theme}: notice hover ${key} differs from folder chip.`);
        }
        await page.keyboard.press("Tab");
        await folder.evaluate((element) => element.focus());
        const folderFocus = await style(folder);
        await action.evaluate((element) => element.focus());
        const focused = await style(action);
        if (!focused.focusVisible || focused.outlineStyle === "none" || focused.outlineWidth === "0px") {
            throw new Error(`${theme}: notice has no focus-visible ring.`);
        }
        for (const key of ["outlineStyle", "outlineWidth", "outlineColor"]) {
            if (focused[key] !== folderFocus[key]) throw new Error(`${theme}: notice ${key} differs from folder chip.`);
        }
        const screenshot = await notice.screenshot();
        if (screenshot.length < 500) throw new Error(`${theme}: notice screenshot is empty.`);
        return screenshot;
    }

    async function disabledAppearance(theme) {
        await selectTheme(theme);
        if (await action.isEnabled()) throw new Error(`${theme}: notice action is enabled without the gateway.`);
        const disabledColor = await page.evaluate(() => {
            const probe = document.createElement("span");
            probe.style.color = "var(--vera-text-disabled)";
            document.body.append(probe);
            const color = getComputedStyle(probe).color;
            probe.remove();
            return color;
        });
        await until(`${theme} disabled style`, async () => (await style(action)).color === disabledColor);
        const actual = await style(action);
        if (actual.cursor !== "default") throw new Error(`${theme}: notice disabled cursor does not match the chip.`);
        const screenshot = await notice.screenshot();
        if (screenshot.length < 500) throw new Error(`${theme}: disabled notice screenshot is empty.`);
        return screenshot;
    }

    async function openBrowser() {
        await press(app, "K", [MODIFIER]);
        const palette = page.getByRole("textbox", { name: "Command palette" });
        await palette.fill("Open a web page");
        await page.locator('[data-command="page.openBrowser"]').click();
        const pane = page.locator('[data-location="rightPane"]');
        await pane.getByRole("textbox", { name: "Address" }).waitFor();
        return pane;
    }

    let pane = await openBrowser();
    let tools = pane.getByRole("switch", { name: "Browser tools" });
    await until("Browser tools switch ready", () => tools.isEnabled());
    if (await tools.isChecked()) throw new Error("Browser tools started on.");
    const address = pane.getByRole("textbox", { name: "Address" });
    await address.fill(`http://127.0.0.1:${site.address().port}/`);
    await address.press("Enter");
    const nativeBounds = () => app.evaluate(({ BrowserWindow }, port) => {
        const child = BrowserWindow.getAllWindows()[0].contentView.children.find((view) => view.webContents?.getURL().includes(`:${port}/`));
        return child?.getBounds();
    }, site.address().port);
    await until("native page shown", async () => (await nativeBounds())?.height > 0);

    await tools.click();
    await notice.waitFor();
    await until("Browser tools switched on", () => tools.isChecked());
    if ((await notice.innerText()) !== "Browser tools are on. Vera can open, read and act on pages in the Browser.\nTurn off") {
        throw new Error(`Unexpected notice text: ${await notice.innerText()}`);
    }
    if (await notice.locator("button").count() !== 1) throw new Error("Notice did not have exactly one action.");
    await until("native page clear of notice", async () => {
        const bounds = await nativeBounds();
        const bar = await notice.boundingBox();
        return bounds !== undefined && bar !== null && bounds.y + bounds.height <= bar.y;
    });
    const composerBox = await composer.boundingBox();
    const noticeBox = await notice.boundingBox();
    if (composerBox === null || noticeBox === null || composerBox.y + composerBox.height > noticeBox.y) throw new Error("Notice overlapped the composer.");
    const dark = await enabledAppearance("dark");
    const light = await enabledAppearance("light");
    if (dark.equals(light)) throw new Error("Light and dark notice screenshots are identical.");
    console.log(`Enabled notice screenshots: dark ${dark.length} bytes, light ${light.length} bytes.`);
    await composer.fill("A draft beside the Browser notice");
    if (await composer.inputValue() !== "A draft beside the Browser notice") throw new Error("The notice blocked the composer.");

    await press(app, "B", [MODIFIER, "alt"]);
    await until("right pane hidden", async () => await page.locator('[data-location="rightPane"]').count() === 0);
    if (!await notice.isVisible()) throw new Error("Notice disappeared when the Browser pane was hidden.");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator('main[data-page="settings"]').waitFor();
    if (!await notice.isVisible()) throw new Error("Notice disappeared on the Settings page.");
    await press(app, "B", [MODIFIER, "alt"]);
    await pane.waitFor();
    if (!await notice.isVisible()) throw new Error("Notice disappeared when the Browser pane reopened.");

    await pane.locator('.switcher-pill:has([data-container="core.browser"]) .switcher-close').click();
    if (!await notice.isVisible()) throw new Error("Notice disappeared when the Browser tab closed.");
    await externalSetting(false);
    await until("external disable reflected without a Browser tab", async () => await notice.count() === 0, 5_000);
    await externalSetting(true);
    await until("external enable reflected without a Browser tab", () => notice.isVisible(), 5_000);
    await notice.getByRole("button", { name: "Turn off" }).click();
    await until("notice action turned Browser tools off", async () => await notice.count() === 0);

    pane = await openBrowser();
    tools = pane.getByRole("switch", { name: "Browser tools" });
    await until("Browser tools available after reopening", () => tools.isEnabled());
    if (await tools.isChecked()) throw new Error("Notice action did not turn off the Browser switch.");
    await tools.click();
    await notice.waitFor();
    await notice.getByRole("button", { name: "Turn off" }).click();
    await until("switch reflects notice action", async () => !await tools.isChecked());
    await until("notice hidden after switch changed", async () => await notice.count() === 0);

    await tools.click();
    await notice.waitFor();
    process.kill(await trial.waitForHost(), "SIGTERM");
    await until("notice stays on after the host disconnects", async () =>
        await notice.isVisible() && !await action.isEnabled(), 20_000);
    const darkDisabled = await disabledAppearance("dark");
    const lightDisabled = await disabledAppearance("light");
    if (darkDisabled.equals(lightDisabled)) throw new Error("Light and dark disabled notice screenshots are identical.");
    console.log(`Disabled notice screenshots: dark ${darkDisabled.length} bytes, light ${lightDisabled.length} bytes.`);
    console.log("browser tools notice e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    if (page !== undefined) console.error("Page:", await page.locator(".app").innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup();
    provider.closeAllConnections();
    site.closeAllConnections();
    await Promise.all([new Promise((resolve) => provider.close(resolve)), new Promise((resolve) => site.close(resolve))]);
}
process.exit(failed ? 1 : 0);
