import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { TelemetryEvent } from "../events.ts";
import type { TelemetrySink } from "./sink.ts";

/** Where the local sink appends, inside the extension's own profile directory. */
export const JSONL_FILE = "events.jsonl";

export function jsonlSink(directory: string): TelemetrySink {
    const file = join(directory, JSONL_FILE);
    return {
        async send(events) {
            if (events.length === 0) return;
            await mkdir(directory, { recursive: true });
            await appendFile(file, events.map((event) => `${JSON.stringify(event)}\n`).join(""));
        },
    };
}
