export interface SubagentExecution {
    readonly agent?: string;
    readonly provider?: string;
    readonly model: string;
    readonly reasoningEffort?: string;
}

export function formatSubagentResult(
    text: string,
    execution: SubagentExecution | undefined,
): string {
    if (execution === undefined) return text;
    const model = execution.provider === undefined
        ? execution.model
        : `${execution.provider}/${execution.model}`;
    return [
        `Agent: ${execution.agent ?? "none"}`,
        `Model: ${model}`,
        `Reasoning effort: ${execution.reasoningEffort ?? "provider default"}`,
        "",
        text,
    ].join("\n");
}
