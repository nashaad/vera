export interface TranscriptEntryIdentity {
    readonly entryId?: string;
    readonly entryAliases?: readonly string[];
}

export function withTranscriptEntryAlias<T extends TranscriptEntryIdentity>(entry: T, id?: string): T {
    if (id === undefined || transcriptEntryHasId(entry, id)) return entry;
    if (entry.entryId === undefined) return { ...entry, entryId: id };
    return { ...entry, entryAliases: [...(entry.entryAliases ?? []), id] };
}

export function transcriptEntryHasId(entry: TranscriptEntryIdentity, id: string): boolean {
    return entry.entryId === id || entry.entryAliases?.includes(id) === true;
}
