import type { FileHandle } from "node:fs/promises";

export async function readRecordTimestamp(file: FileHandle, offset: number, length: number): Promise<string | undefined> {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let consumed = 0;
    let depth = 0;
    let state: "key" | "colon" | "value" | "nested" | "primitive" | "after" = "key";
    let key = "";
    let keyBytes: number[] = [];
    let keyTooLong = false;
    let stringKind: "key" | "timestamp" | "other" | undefined;
    let stringAtRoot = false;
    let escaped = false;
    let decoder: TextDecoder | undefined;
    let timestampParts: string[] = [];
    let timestamp: string | undefined;
    while (consumed < length - 1) {
        const wanted = Math.min(chunk.length, length - 1 - consumed);
        const { bytesRead } = await file.read(chunk, 0, wanted, offset + consumed);
        if (bytesRead === 0) throw new Error("Unexpected end of session file");
        consumed += bytesRead;
        let partStart = stringKind === "timestamp" ? 0 : -1;
        for (let position = 0; position < bytesRead; position += 1) {
            const byte = chunk[position]!;
            if (stringKind !== undefined) {
                if (stringKind === "key") {
                    if (keyBytes.length < 64) keyBytes.push(byte);
                    else keyTooLong = true;
                }
                if (escaped) { escaped = false; continue; }
                if (byte === 92) { escaped = true; continue; }
                if (byte !== 34) continue;
                if (stringKind === "key") {
                    key = keyTooLong ? "" : JSON.parse(Buffer.from(keyBytes).toString("utf8")) as string;
                    state = "colon";
                } else if (stringKind === "timestamp") {
                    timestampParts.push(decoder!.decode(chunk.subarray(partStart, position + 1), { stream: true }), decoder!.decode());
                    const value: unknown = JSON.parse(timestampParts.join(""));
                    timestamp = typeof value === "string" ? value : undefined;
                    timestampParts = [];
                    decoder = undefined;
                    partStart = -1;
                    state = "after";
                } else if (stringAtRoot) state = "after";
                stringKind = undefined;
                continue;
            }
            if (byte === 32 || byte === 9 || byte === 10 || byte === 13) {
                if (depth === 1 && state === "primitive") state = "after";
                continue;
            }
            if (depth === 0) {
                if (byte === 123) { depth = 1; state = "key"; }
                continue;
            }
            if (depth > 1) {
                if (byte === 34) { stringKind = "other"; stringAtRoot = false; }
                else if (byte === 123 || byte === 91) depth += 1;
                else if (byte === 125 || byte === 93) {
                    depth -= 1;
                    if (depth === 1) state = "after";
                }
                continue;
            }
            if (state === "key" && byte === 34) {
                stringKind = "key";
                keyBytes = [34];
                keyTooLong = false;
            } else if (state === "colon" && byte === 58) state = "value";
            else if (state === "value") {
                if (byte === 34) {
                    stringAtRoot = true;
                    stringKind = key === "timestamp" ? "timestamp" : "other";
                    if (stringKind === "timestamp") {
                        decoder = new TextDecoder();
                        timestampParts = [];
                        partStart = position;
                    }
                } else if (byte === 123 || byte === 91) { depth += 1; state = "nested"; }
                else state = "primitive";
            } else if ((state === "after" || state === "primitive") && byte === 44) state = "key";
            else if ((state === "after" || state === "primitive" || state === "key") && byte === 125) depth = 0;
        }
        if (partStart >= 0) timestampParts.push(decoder!.decode(chunk.subarray(partStart, bytesRead), { stream: true }));
    }
    return timestamp;
}
