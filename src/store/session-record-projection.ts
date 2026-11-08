export function sessionRecordForWire(record: Record<string, unknown>): Record<string, unknown> {
    if (record.type !== "harness_message" || !("crashCut" in record)) return record;
    const projected = { ...record };
    delete projected.crashCut;
    return projected;
}
