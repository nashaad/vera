#!/usr/bin/env bun

import { runCliMain } from "../cli/main.ts";

if (import.meta.main) {
    process.exitCode = await runCliMain([
        "stdio",
        ...process.argv.slice(2),
    ]);
}
