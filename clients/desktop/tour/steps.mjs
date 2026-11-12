// The desktop tour as data: each step drives the window through `tour` and takes its screenshots with tour.shot().
// Each step's last shot has no label, so every step leaves one NN-name.png.

export const steps = [
    {
        name: "landing",
        run: async (tour) => {
            await tour.beat(3);
            await tour.shot();
        },
    },
    {
        name: "new-chat",
        critical: true,
        run: async (tour) => {
            const { page } = tour;
            await tour.press("N", ["meta"]);
            await tour.beat();
            await page.waitForSelector("text=Where to, captain?", { timeout: 10_000 });
            await page.locator(".context-chips button").first().click();
            await tour.beat();
            await page.getByRole("menuitem", { name: /Open folder/ }).click();
            await page.waitForSelector(".context-chips .chip-label:text-is(\"crow-nest\")", { timeout: 10_000 });
            await tour.beat();
            await page.getByRole("button", { name: /Default approvals/ }).click();
            await tour.beat();
            await page.getByRole("menuitemradio", { name: /Ask for approval/ }).click();
            await tour.beat(2);
            await tour.shot();
        },
    },
    {
        name: "first-message",
        run: async (tour) => {
            const { page } = tour;
            await tour.send("Ahoy! Give me a two-line motto for a pirate crow who hoards shiny buttons.");
            // Only the scripted reply is known in advance; a real model gets a fixed wait instead.
            if (tour.real) await tour.beat(3);
            else await page.waitForSelector("text=gleam", { timeout: 45_000 });
            await tour.shot("streaming");
            await tour.waitForTurnEnd();
            await tour.beat(3);
            await tour.shot();
        },
    },
    {
        name: "edit",
        run: async (tour) => {
            const { page } = tour;
            await tour.send("Add a line '- Shiny buttons: 3' to the end of treasure.md in this folder, then run the shell command `mkdir -p map-room` here.");
            await tour.waitForTurnEnd(180_000);
            await tour.beat(2);
            const rollup = page.locator(".diff-rollup").last();
            await rollup.scrollIntoViewIfNeeded();
            await rollup.locator(".diff-file-head").first().click();
            await tour.beat(3);
            await tour.shot("diff");
            await rollup.locator(".diff-review").click();
            await tour.beat(4);
            await tour.shot();
        },
    },
    {
        name: "approval",
        run: async (tour) => {
            const { page } = tour;
            await tour.send("Run the shell command `touch ../lookout.txt` exactly as written, then tell me it is done.");
            const card = page.locator(".request-card[data-kind=\"approval\"]");
            await card.waitFor({ timeout: 90_000 });
            await tour.beat(3);
            await tour.shot("card");
            await page.locator(".composer-input").focus();
            await page.keyboard.press("1");
            await card.waitFor({ state: "detached", timeout: 15_000 });
            await tour.waitForTurnEnd();
            await tour.beat(3);
            await tour.shot();
        },
    },
    {
        name: "model-pill",
        run: async (tour) => {
            await tour.page.locator(".model-pill").click();
            await tour.beat(3);
            await tour.shot();
            await tour.closeMenu();
        },
    },
    {
        name: "effort-pill",
        run: async (tour) => {
            await tour.page.locator(".effort-pill").click();
            await tour.beat(3);
            await tour.shot();
            await tour.closeMenu();
        },
    },
    {
        name: "context-pill",
        run: async (tour) => {
            await tour.page.locator(".context-pill").click();
            await tour.beat(3);
            await tour.shot();
            await tour.closeMenu();
        },
    },
    {
        name: "session-menu",
        run: async (tour) => {
            await tour.page.locator("[data-session-menu]").click();
            await tour.beat(3);
            await tour.shot();
            await tour.closeMenu();
        },
    },
    {
        name: "models",
        run: async (tour) => {
            const { page } = tour;
            await page.locator(".model-pill").click();
            await tour.beat();
            await page.getByRole("button", { name: /All models/ }).click();
            await tour.beat(4);
            await tour.shot();
            await tour.closeMenu();
        },
    },
    {
        name: "palette",
        run: async (tour) => {
            const { page } = tour;
            await tour.press("K", ["meta"]);
            await tour.beat();
            await page.locator("input[aria-label=\"Command palette\"]").pressSequentially("sett", { delay: tour.typingDelay });
            await tour.beat(3);
            await tour.shot();
            await tour.closeMenu();
        },
    },
    {
        name: "work",
        run: async (tour) => {
            await tour.openPage("work");
            await tour.beat(3);
            await tour.shot();
        },
    },
    {
        name: "search",
        run: async (tour) => {
            const { page } = tour;
            await tour.openPage("search");
            await page.locator("input[aria-label=\"Search sessions\"]").pressSequentially("buttons", { delay: tour.typingDelay });
            await tour.beat(3);
            await tour.shot();
        },
    },
    {
        name: "customize",
        run: async (tour) => {
            await tour.openPage("customize");
            await tour.beat(3);
            await tour.shot();
        },
    },
    {
        name: "settings",
        run: async (tour) => {
            await tour.openPage("settings");
            await tour.beat(3);
            await tour.shot();
        },
    },
    {
        name: "devices",
        run: async (tour) => {
            await tour.openPage("devices");
            await tour.beat(3);
            await tour.shot();
        },
    },
    {
        name: "back-to-session",
        run: async (tour) => {
            await tour.page.locator(".list-row[data-session], [data-session]").first().click();
            await tour.beat(3);
            await tour.shot();
        },
    },
];
