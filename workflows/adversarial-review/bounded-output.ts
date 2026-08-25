export interface BoundedOutput {
    readonly text: string;
    readonly totalBytes: number;
    readonly retainedBytes: number;
    readonly truncated: boolean;
}

export async function captureBounded(
    stream: ReadableStream<Uint8Array>,
    limitBytes: number,
    label: string,
): Promise<BoundedOutput> {
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
            if (done) break;
            if (value === undefined || value.length === 0) continue;
            totalBytes += value.length;
            if (headBytes < half) {
                const wanted = Math.min(value.length, half - headBytes);
                head.push(value.subarray(0, wanted));
                headBytes += wanted;
                if (wanted === value.length) continue;
                tail.push(value.subarray(wanted));
                tailBytes += value.length - wanted;
            } else {
                tail.push(value);
                tailBytes += value.length;
            }
            while (
                tail.length > 0
                && tailBytes - (tail[0] as Uint8Array).length >= half
            ) {
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

    const tailBuffer = concat(tail);
    const trimmedTail = tailBuffer.subarray(
        Math.max(0, tailBuffer.length - half),
    );
    const headText = decode(concat(head));
    const tailText = decode(trimmedTail);
    const retainedBytes = Buffer.byteLength(headText, "utf8")
        + Buffer.byteLength(tailText, "utf8");
    return {
        text: `${headText}\n${marker(label, totalBytes, retainedBytes)}\n`
            + tailText,
        totalBytes,
        retainedBytes,
        truncated: true,
    };
}

function marker(label: string, totalBytes: number, retainedBytes: number): string {
    return `[vera] ${totalBytes - retainedBytes} bytes omitted from the middle `
        + `of ${label}: ${retainedBytes} of ${totalBytes} bytes are shown, as a `
        + "head and a tail.";
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

function decode(bytes: Uint8Array): string {
    return new TextDecoder("utf-8")
        .decode(bytes)
        .replace(/^�+/, "")
        .replace(/�+$/, "");
}
