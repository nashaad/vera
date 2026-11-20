export interface ToolExitFact {
    readonly exitCode?: number;
    readonly isError?: boolean;
    readonly withheld?: boolean;
}

export function toolExitCode(fact: ToolExitFact): number | undefined {
    return fact.withheld === true || fact.exitCode === undefined || fact.exitCode === 0
        ? undefined
        : fact.exitCode;
}

export function toolFailed(fact: ToolExitFact): boolean {
    return fact.withheld !== true
        && fact.isError === true
        && toolExitCode(fact) === undefined;
}

export function toolExitSummary(facts: readonly ToolExitFact[]): string[] {
    const codes: number[] = [];
    const counts: number[] = [];
    const omitted = new Set<number>();
    for (const fact of facts) {
        const code = toolExitCode(fact);
        if (code === undefined) continue;
        const found = codes.indexOf(code);
        if (found !== -1) {
            counts[found]! += 1;
        } else if (codes.length < 3) {
            codes.push(code);
            counts.push(1);
        } else {
            omitted.add(code);
        }
    }
    const tags = codes.map((code, index) =>
        `exit ${code}${counts[index]! > 1 ? ` ×${counts[index]}` : ""}`
    );
    if (omitted.size > 0) tags.push(`+${omitted.size}`);
    return tags;
}
