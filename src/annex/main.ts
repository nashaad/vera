#!/usr/bin/env bun

import { startAnnexServer } from "./server.ts";
import { annexPathsFromHome } from "./home.ts";

process.title = "vera-annex";

function fail(message: string): never {
    process.stderr.write(`vera-annex: ${message}\n`);
    process.exit(1);
}

function parseArgs(argv: readonly string[]): {
    readonly home: string;
    readonly port: number;
    readonly assets: string | undefined;
} {
    let home: string | undefined;
    let port: number | undefined;
    let assets: string | undefined;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--home") {
            home = argv[++i];
            if (home === undefined || home.length === 0) {
                fail("missing --home path");
            }
            continue;
        }
        if (arg === "--port") {
            const raw = argv[++i];
            const parsed = raw === undefined ? Number.NaN : Number(raw);
            if (!Number.isInteger(parsed) || parsed < 0) {
                fail(`invalid --port: ${raw ?? "(missing)"}`);
            }
            port = parsed;
            continue;
        }
        if (arg === "--assets") {
            assets = argv[++i];
            if (assets === undefined || assets.length === 0) {
                fail("missing --assets path");
            }
            continue;
        }
        if (arg === undefined) {
            fail("usage: vera-annex --home <vera-home> --port <n>");
        }
        fail(`unknown argument: ${arg}`);
    }
    if (home === undefined || home.length === 0 || port === undefined) {
        fail("usage: vera-annex --home <vera-home> --port <n>");
    }
    return { home, port, assets };
}

if (import.meta.main) {
    const { home, port, assets } = parseArgs(Bun.argv.slice(2));
    process.env.VERA_HOME = home;
    const paths = annexPathsFromHome(home);
    try {
        const server = await startAnnexServer({
            sessionDirectory: paths.sessionDirectory,
            catalogCacheDir: paths.catalogCacheDir,
            reviewLogPath: paths.reviewLogPath,
            port,
            ...(assets === undefined ? {} : { webRoot: assets }),
        });
        process.stdout.write(`${server.url}\n`);
        const shutdown = async (): Promise<void> => {
            await server.close();
            process.exit(0);
        };
        process.on("SIGTERM", () => void shutdown());
        process.on("SIGINT", () => void shutdown());
    } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
    }
}
