import { join } from "node:path";

import { installRelease } from "../../src/release/install.ts";
import { runUpdateCheckJson, runUpdateJson } from "../../src/release/update-json.ts";
import type { UpdateOptions } from "../../src/release/update.ts";
import {
    API,
    fakeFetch,
    withTempEnvironment,
    type DesktopUpdateRun,
    type FakeRoute,
} from "./update-fixtures.ts";

export type Line = Record<string, unknown>;

export interface JsonRun {
    readonly exit: number;
    readonly lines: Line[];
    readonly notes: string;
}

export function baseOptions(setup: DesktopUpdateRun, routes: Record<string, FakeRoute>): UpdateOptions {
    return {
        prefix: setup.prefix,
        running: { root: setup.oldRoot, prefix: setup.prefix, version: "0.1.0-alpha.1", buildId: "vera-old" },
        platform: "darwin",
        arch: "arm64",
        releasesApi: API,
        fetch: fakeFetch(routes),
        install: (options) => installRelease({ ...options, readLiveHost: async () => undefined }),
    };
}

export async function jsonRun(
    setup: DesktopUpdateRun,
    routes: Record<string, FakeRoute>,
    extra: Partial<UpdateOptions> = {},
    mode: "update" | "check" = "update",
): Promise<JsonRun> {
    const out: string[] = [];
    const notes: string[] = [];
    const run = mode === "check" ? runUpdateCheckJson : runUpdateJson;
    const exit = await withTempEnvironment(join(setup.root, "home"), () => run({
        ...baseOptions(setup, routes),
        ...extra,
        check: mode === "check",
        output: (text) => out.push(text),
        errorOutput: (text) => notes.push(text),
    }));
    const lines = out.join("").split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Line);
    return { exit, lines, notes: notes.join("") };
}

export const finalLine = (run: JsonRun): Line => run.lines[run.lines.length - 1]!;
