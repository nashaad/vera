
export const TOOL_RESULT_CEILING_BYTES = 64 * 1024;

/** A small window cannot spend the flat ceiling on one result and still work. */
const TOOL_RESULT_CEILING_WINDOW_SHARE = 0.15;
/** Above the verbatim spill floor, so a trimmed result always has a spill file to point at. */
export const TOOL_RESULT_CEILING_FLOOR_BYTES = 4 * 1024;
const BYTES_PER_TOKEN = 4;

/**
 * The ceiling a window of this size can afford. Unknown capacity keeps the
 * flat ceiling; a large window reaches the same value through the clamp.
 */
export function toolResultCeilingBytes(capacity: number | undefined): number {
    if (capacity === undefined || !Number.isFinite(capacity)) {
        return TOOL_RESULT_CEILING_BYTES;
    }
    const share = capacity * TOOL_RESULT_CEILING_WINDOW_SHARE * BYTES_PER_TOKEN;
    return Math.min(
        TOOL_RESULT_CEILING_BYTES,
        Math.max(TOOL_RESULT_CEILING_FLOOR_BYTES, Math.floor(share)),
    );
}

export interface ToolResultTruncation {
    readonly originalBytes: number;
    readonly retainedBytes: number;
    readonly spillPath?: string;
}

export interface LimitedToolResult {
    readonly text: string;
    readonly truncation?: ToolResultTruncation;
}

export interface ToolResultSpill {
    write(toolName: string, text: string): Promise<string | undefined>;
}

export interface LimitToolResultOptions {
    readonly toolName: string;
    readonly spill?: ToolResultSpill;
    readonly ceilingBytes?: number;
}

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

function decode(bytes: Uint8Array): string {
    return new TextDecoder("utf-8")
        .decode(bytes)
        .replace(/^�+/, "")
        .replace(/�+$/, "");
}
