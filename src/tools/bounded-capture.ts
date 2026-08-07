/**
 * Reading a child's output without letting it become the process's problem.
 *
 * The engine ceiling bounds what the model sees, but it applies to a string
 * that already exists: by the time a 2 GiB `cat` has been buffered, the memory
 * is spent and the process may be gone. This bounds the buffer instead, at the
 * point the bytes arrive.
 *
 * Draining continues after the limit is reached. Stopping the reads leaves the
 * child's pipe to fill, and a child blocked writing to a full pipe never
 * exits, so the tool call that was merely too big becomes a hang.
 */

export const BASH_CAPTURE_LIMIT_BYTES = 1024 * 1024;

export interface BoundedCapture {
    /** The retained text: the head, then a marker, then the tail. */
    readonly text: string;
    /** Everything the child wrote, including what was dropped. */
    readonly totalBytes: number;
    readonly retainedBytes: number;
    readonly truncated: boolean;
}

/**
 * Reads a stream to its end, keeping the first and last `limitBytes / 2`.
 *
 * Head and tail rather than either alone: the head has the command's own
 * echo and the first error, the tail has the summary and the exit path, and a
 * middle of a million lines is where the least is happening.
 */
export async function captureBounded(
    stream: ReadableStream<Uint8Array>,
    limitBytes: number,
    label: string,
): Promise<BoundedCapture> {
    const half = Math.max(1, Math.floor(limitBytes / 2));
    const head: Uint8Array[] = [];
    let headBytes = 0;
    const tail: Uint8Array[] = [];
    let tailBytes = 0;
    let totalBytes = 0;

    const reader = stream.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            if (value === undefined || value.length === 0) {
                continue;
            }
            totalBytes += value.length;
            if (headBytes < half) {
                const wanted = Math.min(value.length, half - headBytes);
                head.push(value.subarray(0, wanted));
                headBytes += wanted;
                if (wanted === value.length) {
                    continue;
                }
                tail.push(value.subarray(wanted));
                tailBytes += value.length - wanted;
            } else {
                tail.push(value);
                tailBytes += value.length;
            }
            while (tail.length > 0 && tailBytes - (tail[0] as Uint8Array).length >= half) {
                tailBytes -= (tail.shift() as Uint8Array).length;
            }
        }
    } finally {
        reader.releaseLock();
    }

    if (totalBytes <= limitBytes) {
        return {
            text: decode(concat([...head, ...tail])),
            totalBytes,
            retainedBytes: totalBytes,
            truncated: false,
        };
    }

    // The oldest retained chunk may still overshoot the tail budget, so the
    // final trim is by bytes rather than by whole chunks.
    const tailBuffer = concat(tail);
    const trimmedTail = tailBuffer.subarray(Math.max(0, tailBuffer.length - half));
    const headText = decode(concat(head));
    const tailText = decode(trimmedTail);
    const retainedBytes = Buffer.byteLength(headText, "utf8")
        + Buffer.byteLength(tailText, "utf8");
    return {
        text: `${headText}\n${captureMarker(label, totalBytes, retainedBytes)}\n`
            + tailText,
        totalBytes,
        retainedBytes,
        truncated: true,
    };
}

/**
 * Says what was dropped in the same words the engine ceiling uses, so a result
 * that passed two limits does not read as two unrelated problems.
 */
export function captureMarker(
    label: string,
    totalBytes: number,
    retainedBytes: number,
): string {
    return `[vera] ${totalBytes - retainedBytes} bytes omitted from the middle `
        + `of ${label}: ${retainedBytes} of ${totalBytes} bytes are shown, as a `
        + "head and a tail. Re-run writing to a file and read a range of it if "
        + "the middle matters.";
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const buffer = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.length;
    }
    return buffer;
}

/** A byte cut lands mid-character; the decoder's marks go with the cut. */
function decode(bytes: Uint8Array): string {
    return new TextDecoder("utf-8")
        .decode(bytes)
        .replace(/^�+/, "")
        .replace(/�+$/, "");
}
