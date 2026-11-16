const MAX_BUILD_MESSAGES = 20;

interface Diagnostic {
    readonly message?: unknown;
    readonly position?: unknown;
}

interface DiagnosticPosition {
    readonly file?: unknown;
    readonly line?: unknown;
    readonly column?: unknown;
}

function oneLine(text: string): string {
    return text.replace(/\r\n?|\n/g, " ");
}

function formatDiagnostic(value: unknown): string {
    let message = String(value);
    let position: unknown;
    if (value !== null && typeof value === "object") {
        const diagnostic = value as Diagnostic;
        if (typeof diagnostic.message === "string") message = diagnostic.message;
        position = diagnostic.position;
    }
    let location = "";
    if (position !== null && typeof position === "object") {
        const { file, line, column } = position as DiagnosticPosition;
        if (typeof file === "string" && file.length > 0) {
            location = file;
            if (typeof line === "number") location += `:${line}`;
            if (typeof column === "number") location += `:${column}`;
            location += ": ";
        }
    }
    return oneLine(`${location}${message}`);
}

export function formatBuildFailure(message: string, diagnostics: readonly unknown[]): string {
    const lines = [oneLine(message)];
    for (let index = 0; index < Math.min(diagnostics.length, MAX_BUILD_MESSAGES); index++) {
        lines.push(formatDiagnostic(diagnostics[index]));
    }
    if (diagnostics.length > MAX_BUILD_MESSAGES) {
        lines.push(`... and ${diagnostics.length - MAX_BUILD_MESSAGES} more`);
    }
    return lines.join("\n");
}

export async function buildWithDiagnostics(
    config: Bun.BuildConfig,
    failureMessage: string,
): Promise<Bun.BuildOutput> {
    let result: Bun.BuildOutput;
    try {
        result = await Bun.build(config);
    } catch (error) {
        if (error instanceof AggregateError) {
            throw new Error(formatBuildFailure(error.message, error.errors), { cause: error });
        }
        throw error;
    }
    if (!result.success) {
        throw new Error(formatBuildFailure(failureMessage, result.logs));
    }
    return result;
}
