/**
 * The ceiling every tool result passes under before the model sees it.
 *
 * A tool result enters the messages array and is resent on every later round
 * of the session, so one oversized result is paid for repeatedly. The ceiling
 * lives here rather than in each tool because a per-tool cap covers only the
 * tools that remember to have one, and it must hold for extension tools whose
 * code Vera does not own.
 *
 * A safety invariant, not a setting: it is a constant, changed by commit.
 */

export const TOOL_RESULT_CEILING_BYTES = 64 * 1024;

/** What was cut, for the event log. */
export interface ToolResultTruncation {
    readonly originalBytes: number;
    readonly retainedBytes: number;
    /** Absent when the full output could not be written anywhere. */
    readonly spillPath?: string;
}

export interface LimitedToolResult {
    readonly text: string;
    /** Absent when the result was under the ceiling and passed untouched. */
    readonly truncation?: ToolResultTruncation;
}

/**
 * Writes the full output somewhere the model can go back to. Implemented by
 * the engine, which owns the session's scratch directory; declared here so the
 * ceiling stays a function of its inputs.
 */
export interface ToolResultSpill {
    /** The path written, or undefined when the write could not happen. */
    write(toolName: string, text: string): Promise<string | undefined>;
}

export interface LimitToolResultOptions {
    readonly toolName: string;
    readonly spill?: ToolResultSpill;
    readonly ceilingBytes?: number;
}

/**
 * Head and tail are kept and the middle goes, because the two ends are where a
 * command says what it did: the head has the invocation and the first
 * failures, the tail has the exit status and the summary.
 */
export async function limitToolResult(
    text: string,
    options: LimitToolResultOptions,
): Promise<LimitedToolResult> {
    const ceiling = options.ceilingBytes ?? TOOL_RESULT_CEILING_BYTES;
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length <= ceiling) {
        return { text };
    }

    const spillPath = await options.spill?.write(options.toolName, text);
    const head = decode(bytes.subarray(0, Math.floor(ceiling / 2)));
    const tail = decode(bytes.subarray(bytes.length - Math.floor(ceiling / 2)));
    const truncation: ToolResultTruncation = {
        originalBytes: bytes.length,
        retainedBytes: Buffer.byteLength(head, "utf8")
            + Buffer.byteLength(tail, "utf8"),
        ...(spillPath === undefined ? {} : { spillPath }),
    };
    return {
        text: `${head}\n${omissionMarker(truncation)}\n${tail}`,
        truncation,
    };
}

/**
 * Says what is missing and what to run to get it. A truncation notice that
 * leaves the model to guess costs a whole extra round: it re-runs the command
 * that was too big in the first place.
 */
function omissionMarker(truncation: ToolResultTruncation): string {
    const omitted = truncation.originalBytes - truncation.retainedBytes;
    const lines = [
        `[vera] ${omitted} bytes omitted from the middle of this result: `
            + `${truncation.retainedBytes} of ${truncation.originalBytes} bytes `
            + "are shown, as a head and a tail.",
    ];
    if (truncation.spillPath !== undefined) {
        lines.push(
            `[vera] Full output: ${truncation.spillPath} `
                + `(${truncation.originalBytes} bytes, disposable).`,
        );
        lines.push(
            "[vera] Read a byte range from it with: "
                + `tail -c +<offset> ${truncation.spillPath} | head -c <length>`,
        );
    }
    return lines.join("\n");
}

/**
 * A byte cut lands mid-character on any multibyte text, and the decoder marks
 * the fragment. Dropping the marks is what keeps the excerpt readable.
 */
function decode(bytes: Uint8Array): string {
    return new TextDecoder("utf-8")
        .decode(bytes)
        .replace(/^�+/, "")
        .replace(/�+$/, "");
}
