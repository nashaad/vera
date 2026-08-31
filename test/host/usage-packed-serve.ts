import { join } from "node:path";

import { startResidentHost } from "../../src/host/runtime.ts";
import { readAnnexUrlThroughHost } from "../../src/annex/host-client.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

async function main(): Promise<void> {
    const webRoot = process.argv[2];
    const root = process.argv[3];
    if (webRoot === undefined || root === undefined) {
        process.stderr.write(
            "usage: usage-packed-serve.ts <web-root> <host-root>\n",
        );
        process.exit(2);
    }

    const host = await startResidentHost({
        config: {
            schema_version: 1,
            provider: "openrouter",
            model: "faux/test",
            approval_mode: "auto",
        },
        createAdapter: () => new FauxAdapter([]),
        socketPath: join(root, "host.sock"),
        lockPath: join(root, "host.json"),
        sessionDirectory: join(root, "sessions"),
        eventLogDirectory: join(root, "logs"),
        webRoot,
    });
    try {
        const result = await readAnnexUrlThroughHost(host.server.socketPath);
        if (!("url" in result)) {
            process.stderr.write(`${result.unavailable}\n`);
            process.exit(1);
        }
        const page = await fetch(new URL("usage", result.url).href);
        const text = await page.text();
        if (page.status !== 200 || !text.includes("Vera · Usage")) {
            process.stderr.write("usage page missing\n");
            process.exit(1);
        }
        process.stdout.write(`${result.url}\n`);
    } finally {
        await host.close();
    }
}

if (import.meta.main) {
    await main();
}
