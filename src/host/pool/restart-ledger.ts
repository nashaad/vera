import {
    appendRestartRecordAsync,
    clearRestartRecordsForSessionAsync,
    listRestartRecordsAsync,
    type RestartRecord,
} from "../../store/restart-records.ts";

export class RestartLedger {
    private pending: Promise<void> = Promise.resolve();

    constructor(private readonly path: string) {}

    append(record: RestartRecord): Promise<void> {
        return this.enqueue(() => appendRestartRecordAsync(record, this.path));
    }

    list(): Promise<readonly RestartRecord[]> {
        return this.enqueue(() => listRestartRecordsAsync(this.path));
    }

    clear(id: string): Promise<number> {
        return this.enqueue(() => clearRestartRecordsForSessionAsync(id, this.path));
    }

    private enqueue<T>(work: () => Promise<T>): Promise<T> {
        const result = this.pending.then(work);
        this.pending = result.then(() => undefined, () => undefined);
        return result;
    }
}
