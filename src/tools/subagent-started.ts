const PREFIX = "Async subagent ";
const SUFFIX = " started. Its final summary will arrive as a task notification.";

// The window reads the child id back out of this sentence, so both sides use these two functions.
export function asyncSubagentStartedText(id: string): string {
    return `${PREFIX}${id}${SUFFIX}`;
}

export function startedSubagentId(output: string): string | undefined {
    const end = output.indexOf(SUFFIX);
    if (end < 0) return undefined;
    const start = output.lastIndexOf(PREFIX, end);
    if (start < 0) return undefined;
    const id = output.slice(start + PREFIX.length, end);
    return /^\S+$/.test(id) ? id : undefined;
}
