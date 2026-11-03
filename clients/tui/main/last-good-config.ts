import { createLastGoodVeraConfigReader, VeraConfigError, type LastGoodVeraConfig } from "../../../src/config.ts";
import { serializeError } from "../flight-recorder.ts";
import type { TuiRuntime } from "./runtime.ts";

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

export function lastGoodConfigNotice(read: LastGoodVeraConfig): string | undefined {
    if (read.error === undefined) return undefined;
    const problem = read.error instanceof VeraConfigError ? read.error.problem : read.error.message;
    const reason = `config.json could not be read: ${problem.replace(/\.$/, "")}.`;
    return read.config === undefined ? reason : `${reason} Showing the last settings that loaded.`;
}
