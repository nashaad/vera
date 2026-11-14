import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { configureFauxHome } from "./faux-home.mjs";
import { startTrial } from "./trial.mjs";

const trial = startTrial();
let failed = false;
try {
    configureFauxHome(trial.home, 65530);
    const app = await trial.launch();
    const page = await app.firstWindow();
    await page.waitForSelector('.app[data-sessions="0"]', { timeout: 45000 });
    await trial.waitForHost();
    await page.getByRole("button", { name: "Feedback", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Report a bug or request a feature" });
    await dialog.waitFor();
    await dialog.getByLabel("Title").fill("Crow cannot sail");
    await dialog.getByLabel("Description").fill("The boat is stuck.");
    await dialog.getByLabel("Include a screenshot of this window").check();
    await dialog.locator("img[alt='Screenshot of this window']").waitFor();
    await dialog.getByRole("button", { name: "Save report" }).click();
    await dialog.getByText("Report saved on this computer.").waitFor({ timeout: 30000 });
    const parent = join(trial.home, "machine", "feedback");
    const reports = readdirSync(parent).filter((name) => !name.startsWith("."));
    if (reports.length !== 1) throw new Error(`Expected one report, found ${reports.length}`);
    const folder = join(parent, reports[0]);
    const report = JSON.parse(readFileSync(join(folder, "report.json"), "utf8"));
    if (report.title !== "Crow cannot sail" || report.source !== "window" || report.images.length !== 1) throw new Error("Unexpected report contents");
    if (readFileSync(join(folder, report.images[0])).length === 0) throw new Error("Screenshot was empty");
    console.log("feedback e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
} finally {
    await trial.cleanup();
}
process.exit(failed ? 1 : 0);
