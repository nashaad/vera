import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { waitForCheckoutRemoval } from "../../clients/host/checkout-watch.ts";

test("resolves once the watched source file is removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-checkout-watch-"));
    const source = join(root, "main.ts");
    await writeFile(source, "");
    const wait = waitForCheckoutRemoval(source, { intervalMs: 10 });
    let resolved = false;
    void wait.promise.then(() => {
        resolved = true;
    });
    try {
        await Bun.sleep(40);
        expect(resolved).toBe(false);

        await rm(root, { recursive: true, force: true });
        await wait.promise;
        expect(resolved).toBe(true);
    } finally {
        wait.dispose();
        await rm(root, { recursive: true, force: true });
    }
});

test("stops checking once disposed", async () => {
    let checks = 0;
    const wait = waitForCheckoutRemoval("/unused", {
        intervalMs: 10,
        exists: () => {
            checks += 1;
            return true;
        },
    });
    await Bun.sleep(35);
    wait.dispose();
    const seen = checks;
    await Bun.sleep(35);

    expect(seen).toBeGreaterThan(0);
    expect(checks).toBe(seen);
});
