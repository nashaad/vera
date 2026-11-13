import { createLastGoodVeraConfigReader, type LastGoodVeraConfig } from "../../../src/config.ts";
import { serializeError } from "../flight-recorder.ts";
import type { TuiRuntime } from "./runtime.ts";

export { lastGoodConfigNotice } from "../../../src/config.ts";

// For opening and drawing screens only. Anything that writes config reads the file strictly.
const readConfig = createLastGoodVeraConfigReader();
let reportedError: string | undefined;

export function readLastGoodConfig(rt: Pick<TuiRuntime, "flightRecorder">): LastGoodVeraConfig {
    const read = readConfig();
    if (read.error === undefined) {
        reportedError = undefined;
    } else if (read.error.message !== reportedError) {
        reportedError = read.error.message;
        rt.flightRecorder?.record({ type: "config_unreadable", error: serializeError(read.error) });
    }
    return read;
}

