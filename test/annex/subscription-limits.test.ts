import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SubscriptionLimitsView } from "../../clients/annex/SubscriptionLimits.tsx";
import { annexPathsFromHome } from "../../src/annex/home.ts";
import { startAnnexServer, type AnnexServer } from "../../src/annex/server.ts";
import { createAuthStorage } from "../../src/providers/auth-storage.ts";
import { OPENAI_CODEX_PROVIDER_ID } from "../../src/providers/openai-codex-oauth.ts";
import type { SubscriptionLimits } from "../../src/providers/subscription-limits.ts";

const LIMITS: SubscriptionLimits = {
    provider: OPENAI_CODEX_PROVIDER_ID,
    fetchedAt: 1_800_000_000_000,
    windows: [
        { windowMinutes: 300, usedPercent: 23, resetsAt: 1_800_003_600_000 },
        { windowMinutes: 10_080, usedPercent: 81, resetsAt: 1_800_090_000_000 },
    ],
};
const root = mkdtempSync(join(tmpdir(), "vera-subscription-page-"));
for (const file of ["index.html", "main.js", "styles.css"]) {
    writeFileSync(join(root, file), "fixture");
}
const servers: AnnexServer[] = [];
afterAll(async () => {
    await Promise.all(servers.map((server) => server.close()));
    rmSync(root, { recursive: true, force: true });
});

test("subscription HTTP facts are independent of report range and failures leave local usage available", async () => {
    let fail = false;
    const server = await startAnnexServer({
        sessionDirectory: join(root, "sessions"),
        webRoot: root,
        readSubscriptionLimits: async () => {
            if (fail) throw new Error("offline");
            return [LIMITS];
        },
    });
    servers.push(server);
    const response = await fetch(`${server.url}api/usage/subscriptions?window=today`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ limits: [LIMITS] });
    const weekly = await fetch(`${server.url}api/usage/subscriptions?window=30d`);
    expect(await weekly.json()).toEqual({ limits: [LIMITS] });
    fail = true;
    expect(await (await fetch(`${server.url}api/usage/subscriptions`)).json()).toEqual({ limits: [] });
    expect((await fetch(`${server.url}api/usage?window=7d`)).status).toBe(200);
    fail = false;
    expect(await (await fetch(`${server.url}api/usage/subscriptions`)).json()).toEqual({ limits: [LIMITS] });
});

test("the server reads only the selected home's credential path and never writes expired credentials", async () => {
    const paths = annexPathsFromHome(join(root, "home"));
    expect(paths.authStoragePath).toBe(join(root, "home", "machine", "auth.json"));
    const storage = createAuthStorage({ path: paths.authStoragePath });
    const credential = {
        type: "oauth" as const,
        token: JSON.stringify({
            schema_version: 1,
            access_token: "expired-access",
            refresh_token: "preserved-refresh",
            expires_at: 1,
        }),
    };
    storage.setCredential(OPENAI_CODEX_PROVIDER_ID, credential);
    const before = await Bun.file(paths.authStoragePath).text();
    const server = await startAnnexServer({
        sessionDirectory: paths.sessionDirectory,
        authStoragePath: paths.authStoragePath,
        webRoot: root,
    });
    servers.push(server);
    expect(await (await fetch(`${server.url}api/usage/subscriptions`)).json()).toEqual({ limits: [] });
    expect(await Bun.file(paths.authStoragePath).text()).toBe(before);
});

test("a server without a credential path has no subscription data", async () => {
    const server = await startAnnexServer({ sessionDirectory: join(root, "empty"), webRoot: root });
    servers.push(server);
    expect(await (await fetch(`${server.url}api/usage/subscriptions`)).json()).toEqual({ limits: [] });
});

test("the view shows percentage left, reset times and account scope, with meters pointing toward remaining use", () => {
    const html = renderToStaticMarkup(createElement(SubscriptionLimitsView, { limits: [LIMITS] }));
    expect(html).toContain("77% left");
    expect(html).toContain("19% left");
    expect(html).toContain('value="77"');
    expect(html).toContain('value="19"');
    expect(html).toContain("5 hours");
    expect(html).toContain("Weekly");
    expect(html).toContain("Account-wide, including work outside Vera.");
    expect(html).toContain("Updated");
    expect(html).toContain(`Resets ${new Date(LIMITS.windows[0]?.resetsAt ?? 0).toLocaleString()}`);
    expect(renderToStaticMarkup(createElement(SubscriptionLimitsView, { limits: [] }))).toBe("");
});

test("the view preserves full and exhausted limits, decimals, and the provider's window duration", () => {
    const html = renderToStaticMarkup(createElement(SubscriptionLimitsView, { limits: [{
        ...LIMITS,
        windows: [
            { windowMinutes: 300, usedPercent: 0, resetsAt: 1_800_003_600_000 },
            { windowMinutes: 10_080, usedPercent: 100, resetsAt: 1_800_090_000_000 },
            { windowMinutes: 60, usedPercent: 12.25, resetsAt: 1_800_003_600_000 },
        ],
    }] }));
    expect(html).toContain("100% left");
    expect(html).toContain("0% left");
    expect(html).toContain("87.8% left");
    expect(html).toContain("1 hour");
});
