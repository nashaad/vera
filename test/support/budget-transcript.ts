import { closeSync, openSync, writeSync } from "node:fs";
import { emptyUsage } from "../../src/model/types.ts";

export function budgetReply(cost?: number, text = "The pirate crow found the treasure."): string {
    return JSON.stringify({ type: "message", id: "reply", parentId: "question", timestamp: "2026-11-04T12:00:00Z",
        message: { role: "assistant", content: [{ type: "text", text }],
            source: { provider: "fixture", api: "fixture", model: "fixture" },
            usage: { ...emptyUsage(), ...(cost === undefined ? {} : { cost }) }, stopReason: "stop" } }) + "\n";
}

export function budgetAsk(cost?: number): string {
    return JSON.stringify({ type: "session_ask", id: "ask", timestamp: "2026-11-04T12:00:00Z",
        billed: { provider: "fixture", model: "fixture",
            usage: { ...emptyUsage(), ...(cost === undefined ? {} : { cost }) } } }) + "\n";
}

export function writeBudgetTranscript(path: string, minimumBytes: number): number {
    const file = openSync(path, "w");
    let bytes = 0;
    let previous: string | null = null;
    const timestamp = "2026-11-04T12:00:00Z";
    const text = "The pirate crow charted the islands. ".repeat(240);
    const write = (entry: object): void => { bytes += writeSync(file, JSON.stringify(entry) + "\n"); };
    try {
        write({ type: "session", version: 1, id: "voyage", timestamp, cwd: "/tmp" });
        for (let index = 0; bytes < minimumBytes; index++) {
            const user = `user-${index}`;
            const reply = `reply-${index}`;
            write({ type: "message", id: user, parentId: previous, timestamp,
                message: { role: "user", content: [{ type: "text", text: "Find the treasure." }] } });
            write({ type: "message", id: reply, parentId: user, timestamp,
                message: { role: "assistant", content: [{ type: "text", text }],
                    source: { provider: "fixture", api: index % 19 === 0 ? "none" : "fixture", model: "fixture" },
                    usage: { ...emptyUsage(), ...(index % 7 === 0 ? {} : { cost: (index % 13) * 0.0000000004 }) },
                    stopReason: index % 11 === 0 ? "error" : "stop" } });
            if (index % 17 === 0) {
                write({ type: "compaction", id: `compact-${index}`, timestamp, boundaryMessageId: reply,
                    firstRetainedMessageId: null, projection: [{ role: "user", content: [{ type: "text", text: "A map of the islands." }] }],
                    measured: { inputTokens: 12, estimated: true },
                    ...(index % 34 === 0 ? {} : { billed: { provider: "fixture", model: "fixture",
                        usage: { ...emptyUsage(), ...(index % 51 === 0 ? {} : { cost: 0.001 }) } } }) });
            }
            if (index % 23 === 0) {
                write({ type: "rewind", timestamp, userMessageId: user, previousHeadId: reply, headId: previous });
            } else previous = reply;
            if (index % 29 === 0) {
                write({ type: "session_ask", id: `ask-${index}`, timestamp,
                    billed: { provider: "fixture", model: "fixture",
                        usage: { ...emptyUsage(), ...(index % 58 === 0 ? {} : { cost: 0.0002 }) } } });
            }
        }
        return bytes;
    } finally {
        closeSync(file);
    }
}
