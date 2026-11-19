import { isStopCause } from "../model/types.ts";

export function sessionRecordForWire(record: Record<string, unknown>): Record<string, unknown> {
    if (record.type !== "harness_message") return record;
    const projected = { ...record };
    delete projected.crashCut;
    if (!isStopCause(projected.stopCause)) {
        delete projected.stopCause;
    }
    return projected;
}
