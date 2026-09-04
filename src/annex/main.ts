#!/usr/bin/env bun

import { fstatSync } from "node:fs";

import { startAnnexServer } from "./server.ts";
import { annexPathsFromHome } from "./home.ts";
import { installLiveProcess } from "../live-process.ts";

process.title = "vera-annex";

function fail(message: string): never {
    process.stderr.write(`vera-annex: ${message}\n`);
    process.exit(1);
}

/**
 * A pipe or socket on stdin comes from a parent that holds the other end. A
 * terminal or /dev/null is a launch by hand, which nothing is waiting to
 * outlive.
 */
function stdinIsAParentsLifeline(): boolean {
    try {
        const stats = fstatSync(0);
        return stats.isFIFO() || stats.isSocket();
    } catch {
        return false;
    }
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
        installLiveProcess("annex", home);
        const shutdown = async (): Promise<void> => {
            await server.close();
            process.exit(0);
        };
        process.on("SIGTERM", () => void shutdown());
        process.on("SIGINT", () => void shutdown());
        if (stdinIsAParentsLifeline()) {
            // The host holds the other end, so its death closes this stdin
            // whatever signal took it, SIGKILL included. The data listener is
            // what starts the read; without it the end never arrives.
            process.stdin.setEncoding("utf8");
            process.stdin.on("data", () => {});
            process.stdin.on("end", () => void shutdown());
            process.stdin.on("close", () => void shutdown());
        }
    } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
    }
}
