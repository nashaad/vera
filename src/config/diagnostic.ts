export interface ConfigFieldProblem {
    // Path to the refused field, such as `extensions[5]`. Empty when the whole value was refused.
    readonly field: string;
    // What was wrong, read after the field path.
    readonly reason: string;
}

let current: { problem?: ConfigFieldProblem } | undefined;

// Parsers call this where they refuse a value and return its result. Outside
// collectConfigProblem it only returns undefined, so a direct caller is unaffected.
export function configProblem(field: string, reason: string): undefined {
    if (current !== undefined && current.problem === undefined) {
        current.problem = { field, reason };
    }
    return undefined;
}

// Only the first refusal is kept: every parser returns right after recording
// one, so a later one would describe a value the parse never reached.
export function collectConfigProblem<T>(
    parse: () => T,
): { readonly value: T; readonly problem?: ConfigFieldProblem } {
    const outer = current;
    const run: { problem?: ConfigFieldProblem } = {};
    current = run;
    try {
        const value = parse();
        return run.problem === undefined
            ? { value }
            : { value, problem: run.problem };
    } finally {
        current = outer;
    }
}

export function describeConfigProblem(problem: ConfigFieldProblem): string {
    return problem.field.length === 0
        ? problem.reason
        : `${problem.field}: ${problem.reason}`;
}

// "expected <what>" plus what the file holds, cut short so one bad value cannot flood the line.
export function expectedValue(expected: string, actual: unknown): string {
    if (actual === undefined) return `expected ${expected}`;
    return `expected ${expected}, found ${shown(actual)}`;
}

function shown(actual: unknown): string {
    const seen = JSON.stringify(actual) ?? String(actual);
    return seen.length > 60 ? `${seen.slice(0, 57)}...` : seen;
}

// Names a key inside an element that has no path of its own, such as `extensions[3]`.
export function keyValue(key: string, expected: string, actual: unknown): string {
    return actual === undefined
        ? `${key} is missing; it must be ${expected}`
        : `${key} must be ${expected}, found ${shown(actual)}`;
}

export function isPlainObject(
    value: unknown,
): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
