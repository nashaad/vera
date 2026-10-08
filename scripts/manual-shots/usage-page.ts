// Regenerates docs/site/public/images/usage-page.png from seeded demo sessions.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startAnnexServer } from "../../src/annex/server.ts";
import type { ModelMessage } from "../../src/model/types.ts";
import { OPENAI_CODEX_PROVIDER_ID } from "../../src/providers/openai-codex-oauth.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { packWebAssets } from "../pack-web.ts";
import { captureFullPage } from "./chrome.ts";

const OUT = resolve(import.meta.dir, "../../docs/site/public/images/usage-page.png");
const DAY = 86_400_000;

const MODELS = [
    { provider: "openrouter", model: "model-large", perCall: 0.024 },
    { provider: "openrouter", model: "model-fast", perCall: 0.006 },
    { provider: "jollyroger", model: "model-mini", perCall: 0.0028 },
    { provider: "openrouter", model: "model-tiny", perCall: 0.001 },
] as const;

interface DemoSession {
    readonly title: string;
    readonly workspace: string;
    readonly calls: number;
    readonly startDaysAgo: number;
    readonly days: number;
    readonly children?: readonly { readonly title: string; readonly calls: number }[];
}

// The last three run in the previous 30 days so the cards have a comparison.
const SESSIONS: readonly DemoSession[] = [
    { title: "Island route planning", workspace: "treasure-map", calls: 640, startDaysAgo: 29, days: 28, children: [{ title: "Chart the reef shallows", calls: 180 }, { title: "Tide table lookup", calls: 90 }] },
    { title: "Shiny coin tally", workspace: "treasure-map", calls: 720, startDaysAgo: 28, days: 27 },
    { title: "Crow's nest storm repairs", workspace: "crows-nest", calls: 520, startDaysAgo: 27, days: 22, children: [{ title: "Find loose rigging", calls: 140 }] },
    { title: "Parrot loot sorter", workspace: "crows-nest", calls: 470, startDaysAgo: 25, days: 24 },
    { title: "Treasure map X marker", workspace: "treasure-map", calls: 380, startDaysAgo: 22, days: 18, children: [{ title: "Verify the X", calls: 60 }] },
    { title: "Spare button burial", workspace: "treasure-map", calls: 330, startDaysAgo: 20, days: 16 },
    { title: "Compass pointing at the galley", workspace: "crows-nest", calls: 300, startDaysAgo: 16, days: 12 },
    { title: "Reef marker tests", workspace: "treasure-map", calls: 250, startDaysAgo: 12, days: 10, children: [{ title: "Run the barnacle suite", calls: 40 }] },
    { title: "Ship rename in README", workspace: "crows-nest", calls: 200, startDaysAgo: 8, days: 7 },
    { title: "Plunder split rules", workspace: "treasure-map", calls: 170, startDaysAgo: 4, days: 4 },
    { title: "Old voyage log cleanup", workspace: "crows-nest", calls: 1500, startDaysAgo: 59, days: 28 },
    { title: "Cannon inventory", workspace: "treasure-map", calls: 1400, startDaysAgo: 58, days: 27 },
    { title: "Figurehead polish", workspace: "crows-nest", calls: 1200, startDaysAgo: 55, days: 24 },
];

// Fixed seed: the same counts and costs on every run; only the dates follow today.
let seed = 7;
function random(): number {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
}

async function writeSession(
    directory: string,
    id: string,
    session: { title: string; workspace: string; calls: number },
    startMs: number,
    endMs: number,
    parentId?: string,
): Promise<void> {
    let clock = new Date(startMs);
    const store = await SessionStore.create(join(directory, `${id}.jsonl`), {
        sessionId: id,
        cwd: `/home/crow/${session.workspace}`,
        now: () => clock,
        ...(parentId === undefined ? {} : { parentId }),
    });
    await store.appendName(session.title);
    await store.appendMessage({ role: "user", content: [{ type: "text", text: session.title }] });

    const dayCount = Math.max(1, Math.round((endMs - startMs) / DAY));
    const weights = Array.from({ length: dayCount }, () => 0.15 + random() ** 2 * 1.6);
    const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
    const times: number[] = [];
    weights.forEach((weight, day) => {
        const count = Math.round((session.calls * weight) / weightSum);
        for (let index = 0; index < count; index += 1) {
            times.push(startMs + (day + random()) * DAY);
        }
    });
    times.sort((a, b) => a - b);

    for (const at of times) {
        if (at > endMs) continue;
        clock = new Date(at);
        const pick = random();
        const model = parentId === undefined
            ? MODELS[pick < 0.55 ? 0 : pick < 0.82 ? 1 : pick < 0.96 ? 2 : 3]
            : MODELS[pick < 0.6 ? 1 : 2];
        const input = Math.round(15_000 + random() * 40_000);
        const output = Math.round(200 + random() * 900);
        const message: ModelMessage = {
            role: "assistant",
            content: [{ type: "text", text: "Aye." }],
            source: { provider: model.provider, api: model.provider, model: model.model },
            usage: {
                inputTokens: input,
                outputTokens: output,
                cachedInputTokens: Math.round(input * (0.55 + random() * 0.25)),
                reasoningTokens: 0,
                totalTokens: input + output,
                cost: Number((model.perCall * (0.6 + random() * 0.8)).toFixed(5)),
            },
            durationMs: 900,
            stopReason: "stop",
        };
        await store.appendMessage(message);
    }
}

async function main(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "vera-usage-shot-"));
    try {
        const sessionDirectory = join(root, "sessions");
        const now = Date.now();
        let count = 0;
        for (const session of SESSIONS) {
            const startMs = now - session.startDaysAgo * DAY;
            const endMs = Math.min(now - 3_600_000, startMs + session.days * DAY);
            const parentId = `demo-${++count}`;
            await writeSession(sessionDirectory, parentId, session, startMs, endMs);
            for (const child of session.children ?? []) {
                const childStart = startMs + DAY;
                const childEnd = Math.min(endMs, childStart + Math.max(1, session.days - 2) * DAY);
                await writeSession(sessionDirectory, `demo-${++count}`, { ...child, workspace: session.workspace }, childStart, childEnd, parentId);
            }
        }

        const webRoot = join(root, "web");
        await packWebAssets(webRoot, { force: true });
        const server = await startAnnexServer({
            sessionDirectory,
            catalogCacheDir: join(root, "catalog"),
            webRoot,
            readSubscriptionLimits: async () => [{
                provider: OPENAI_CODEX_PROVIDER_ID,
                fetchedAt: now,
                windows: [
                    { windowMinutes: 300, usedPercent: 23, resetsAt: now + 3_600_000 },
                    { windowMinutes: 10_080, usedPercent: 81, resetsAt: now + 3 * DAY },
                ],
            }],
        });
        try {
            await captureFullPage({
                url: `${server.url}usage`,
                outPath: OUT,
                width: 1400,
                scale: 2,
                prepare: `(async () => {
                    const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
                    for (let i = 0; i < 50 && !document.querySelector("button"); i += 1) await sleep(100);
                    const button = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "30 days");
                    if (!button) throw new Error("no 30 days button");
                    button.click();
                    await sleep(2500);
                })()`,
            });
        } finally {
            await server.close();
        }
        console.log(`wrote ${OUT}`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

if (import.meta.main) {
    await main();
}
