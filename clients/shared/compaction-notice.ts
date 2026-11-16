export function droppedCompactionNotice(strategy: string | undefined): string | undefined {
    if (strategy !== "vera/drop-oldest") return undefined;
    return "Earlier messages were dropped from the model's context. "
        + "They are still shown in the conversation.";
}

export function failedDropNotice(strategy: string | undefined, reason: string | undefined): string | undefined {
    if (strategy !== "vera/drop-oldest") return undefined;
    return `Could not drop earlier messages${reason === undefined ? "" : `: ${reason}`}`;
}
