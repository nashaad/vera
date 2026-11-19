import { isStopCause } from "../../src/model/types.ts";

export function stopCauseText(value: unknown): string | undefined {
    if (!isStopCause(value)) return undefined;
    return value === "host_stopped" ? "Host stopped" : "Host stopped unexpectedly";
}
