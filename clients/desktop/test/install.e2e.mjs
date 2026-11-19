// Install test for the desktop shell. Run with: node clients/desktop/test/install.e2e.mjs
// A trial run never installs a bundled release, so the main process's install events are sent to the
// window directly: the sidebar says Installing Vera, a failed install that kept a working Vera shows
// a notice the user can dismiss, and one that left no Vera shows the blocking banner.

import { startTrial } from "./trial.mjs";

const EVENT_CHANNEL = "vera:event";

const NOTICE_TITLE = "Vera could not install its bundled release";
const REASON = "The bundled release archive does not match its checksum.";
const KEPT = `${REASON} Vera is using the release you already had.`;
const BLOCKED = `Vera could not install the release inside this app. ${REASON} Choose Try again to retry.`;

const trial = startTrial();
let failed = false;
let page;

async function send(app, event) {
    await app.evaluate(({ BrowserWindow }, { channel, event }) => {
        BrowserWindow.getAllWindows()[0].webContents.send(channel, event);
    }, { channel: EVENT_CHANNEL, event });
}

async function stateLabel() {
    return (await page.locator(".sidebar-foot-state").first().innerText()).trim();
}

async function until(what, check) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${what}.`);
}

try {
    const app = await trial.launch();
    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: 45_000 });
    const pid = await trial.waitForHost();
    const ready = { type: "ready", pid, socketPath: `${trial.home}/runtime/host.sock`, buildId: null, home: trial.home };

    // The install runs before the host starts: the sidebar shows it where the connecting state shows.
    await send(app, { type: "phase", phase: "installing" });
    await until("the installing label", async () => (await stateLabel()).startsWith("Installing Vera…"));
    if (await page.locator(".banner").count() !== 0) throw new Error("A banner showed while installing.");
    if (await page.locator(".sidebar-foot-state").first().getAttribute("data-tone") !== "info") {
        throw new Error("The installing state is not neutral.");
    }

    // A failed install with a Vera already on the machine attaches and tells the user why.
    await send(app, { type: "phase", phase: "starting" });
    await until("the starting label", async () => (await stateLabel()).startsWith("Starting"));
    await send(app, { type: "install_notice", message: KEPT });
    await send(app, ready);
    const banner = page.locator(".banner");
    await banner.waitFor({ timeout: 10_000 });
    if ((await banner.locator(".banner-title").innerText()) !== NOTICE_TITLE) throw new Error("The notice has the wrong title.");
    if ((await banner.locator(".banner-detail").innerText()) !== KEPT) throw new Error("The notice does not give the reason.");
    if ((await banner.getAttribute("data-tone")) !== "warning") throw new Error("The notice is not a warning.");
    if (await banner.getByRole("button", { name: "Try again" }).count() !== 0) throw new Error("The notice offers Try again.");
    await until("the attached label", async () => (await stateLabel()).startsWith("Attached"));

    // Dismiss removes it, and a later attach does not bring it back.
    await banner.getByRole("button", { name: "Dismiss" }).click();
    await banner.waitFor({ state: "detached", timeout: 5_000 });
    await send(app, ready);
    await until("the attached label", async () => (await stateLabel()).startsWith("Attached"));
    if (await page.locator(".banner").count() !== 0) throw new Error("The dismissed notice came back.");

    // With no Vera to fall back on the banner blocks, names the reason and offers Try again.
    await send(app, { type: "phase", phase: "installing" });
    await send(app, { type: "failed", message: BLOCKED });
    const blocking = page.locator(".banner");
    await blocking.waitFor({ timeout: 10_000 });
    if ((await blocking.locator(".banner-title").innerText()) !== "Vera did not start") throw new Error("The blocking banner has the wrong title.");
    if ((await blocking.locator(".banner-detail").innerText()) !== BLOCKED) throw new Error("The blocking banner does not give the reason.");
    await blocking.getByRole("button", { name: "Try again" }).waitFor({ timeout: 5_000 });
    if (await blocking.getByRole("button", { name: "Dismiss" }).count() !== 0) throw new Error("The blocking banner can be dismissed.");

    console.log("install e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    if (page !== undefined) console.error("Page text:", await page.locator(".app").first().innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup();
}
process.exit(failed ? 1 : 0);
