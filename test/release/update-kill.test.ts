import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { releasesDirectory } from "../../src/release/layout.ts";
import { readUpgradeJournal } from "../../src/release/upgrade.ts";
import {
    expectWholePair,
    finish,
    runChild,
    startChild,
    touch,
    waitForFile,
    withWorld,
    type ChildRun,
    type World,
} from "./update-process.ts";

const finalResult = (run: ChildRun): string | undefined => {
    const result = run.lines[run.lines.length - 1]?.result;
    return typeof result === "string" ? result : undefined;
};

function leftovers(world: World): string[] {
    const hidden = readdirSync(releasesDirectory(world.prefix)).filter((name) => name.startsWith("."));
    const beside = readdirSync(dirname(world.app)).filter((name) => name !== "Vera.app");
    return [...hidden, ...beside];
}

const UPDATE_STEPS = [
    "update:release-staged",
    "update:package-staged",
    "update:before-switch",
    "shell:placed",
    "activate:start",
    "activate:rollback-linked",
    "activate:current-linked",
    "activate:launcher-written",
    "install:activated",
];

test("@core an update killed at any step leaves a whole pair, and running it again completes", async () => {
    for (const step of UPDATE_STEPS) {
        await withWorld(async (world) => {
            const killed = await runChild(world, { mode: "update" }, step);
            expect(killed.signal, `${step}: the child ended on its own: ${killed.stderr}`).toBe("SIGKILL");
            const afterKill = await expectWholePair(world, `after a kill at ${step}`);

            const rerun = await runChild(world, { mode: "update" });
            expect(rerun.code, `${step}: ${rerun.stderr}`).toBe(0);
            expect(["done", "up_to_date"], step).toContain(finalResult(rerun) ?? "");
            const finished = await expectWholePair(world, `after the rerun of ${step}`);
            expect(finished.current, step).toBe("vera-new");
            expect(finished.shellApi, step).toBe(2);
            expect(leftovers(world), step).toEqual([]);
            // A kill after current moved is already the new pair.
            if (afterKill.current === "vera-new") expect(afterKill.shellApi, step).toBe(2);
        }, { newShell: true });
    }
}, 180_000);

test("@core a download-only run killed at any step leaves the old pair, and the update completes", async () => {
    for (const step of ["update:release-staged", "update:package-staged"]) {
        await withWorld(async (world) => {
            const killed = await runChild(world, { mode: "download-only" }, step);
            expect(killed.signal, step).toBe("SIGKILL");
            expect((await expectWholePair(world, step)).current).toBe("vera-old");
            const again = await runChild(world, { mode: "download-only" });
            expect(finalResult(again), `${step}: ${again.stderr}`).toBe("downloaded");
            const done = await runChild(world, { mode: "update" });
            expect(finalResult(done), step).toBe("done");
            expect((await expectWholePair(world, `${step} done`)).current).toBe("vera-new");
        }, { newShell: true });
    }
}, 120_000);

const ROLLBACK_STEPS = [
    "upgrade:journal-activating",
    "activate:start",
    "activate:rollback-linked",
    "activate:current-linked",
    "upgrade:activated",
    "upgrade:journal-starting",
];

test("@core a rollback killed at any step leaves a whole pair, and running it again finishes it", async () => {
    for (const step of ROLLBACK_STEPS) {
        await withWorld(async (world) => {
            const updated = await runChild(world, { mode: "update" });
            expect(finalResult(updated), `${step}: ${updated.stderr}`).toBe("done");
            const pin = (await expectWholePair(world, `${step} before`)).current;
            expect(pin).toBe("vera-new");

            const killed = await runChild(world, { mode: "rollback" }, step);
            expect(killed.signal, `${step}: ${killed.stderr}`).toBe("SIGKILL");
            await expectWholePair(world, `after a kill at ${step}`);

            const rerun = await runChild(world, { mode: "rollback" });
            expect(rerun.code, `${step}: ${rerun.stderr}`).toBe(0);
            await expectWholePair(world, `after the rerun of ${step}`);
            expect(await readUpgradeJournal(world.prefix), step).toBeUndefined();
        }, { newShell: true });
    }
}, 180_000);

test("@core a reader that goes away after the switch began does not stop the switch", async () => {
    await withWorld(async (world) => {
        const gate = join(world.root, "gate");
        const child = startChild(world, { mode: "update", gate });
        let seen = "";
        child.stdout?.on("data", (chunk: Buffer) => { seen += chunk.toString(); });
        await waitForFile(`${gate}.ready`);
        expect(seen).toContain('"phase":"switching"');
        child.stdout?.destroy();
        child.stderr?.destroy();
        const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
            child.on("close", (code, signal) => resolve({ code, signal }));
        });
        touch(gate);
        const ended = await closed;
        expect(ended.signal).toBeNull();
        expect(ended.code).toBe(0);
        const pair = await expectWholePair(world, "after the reader closed");
        expect(pair.current).toBe("vera-new");
        expect(pair.shellApi).toBe(2);
        expect(leftovers(world)).toEqual([]);
    }, { newShell: true });
});

test("@core a reader that goes away during the download cancels the update with the old pair intact", async () => {
    await withWorld(async (world) => {
        const child = startChild(world, { mode: "update" });
        await new Promise<void>((resolve) => {
            let seen = "";
            child.stdout?.on("data", (chunk: Buffer) => {
                seen += chunk.toString();
                if (seen.includes('"phase":"downloading"')) resolve();
            });
        });
        child.stdout?.destroy();
        child.stderr?.destroy();
        const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
            child.on("close", (code, signal) => resolve({ code, signal }));
        });
        expect(ended.signal).toBeNull();
        expect(ended.code).toBe(1);
        expect((await expectWholePair(world, "after the reader closed")).current).toBe("vera-old");
        expect(readdirSync(releasesDirectory(world.prefix)).sort()).toEqual(["vera-old"]);
        expect(existsSync(join(world.prefix, "share", "vera", ".update.lock"))).toBe(false);

        const retry = await runChild(world, { mode: "update" });
        expect(finalResult(retry)).toBe("done");
    }, { newShell: true, slowHostMs: 150 });
});

test("two updates at once: the second ends failed, and the first finishes whole", async () => {
    await withWorld(async (world) => {
        const gate = join(world.root, "gate");
        const first = startChild(world, { mode: "update", gate });
        const firstEnded = finish(first);
        await waitForFile(`${gate}.ready`);
        const second = await runChild(world, { mode: "update" });
        expect(second.code).toBe(1);
        const last = second.lines[second.lines.length - 1]!;
        expect(last).toMatchObject({ result: "failed", changed: false });
        expect(String(last.message)).toContain("Another vera update or rollback is running");
        touch(gate);
        const ended = await firstEnded;
        expect(finalResult(ended), ended.stderr).toBe("done");
        expect((await expectWholePair(world, "after both")).current).toBe("vera-new");
    }, { newShell: true });
});
