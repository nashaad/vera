import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProvider } from "../../dev/load/provider.ts";

interface WireMessage {
    role: string;
    content?: string | null;
    tool_call_id?: string;
    tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
}
interface ToolCall { id: string; name: string; }
interface Chunk {
    choices: { delta: { tool_calls?: { id?: string; function?: { name?: string } }[] }; finish_reason: string | null }[];
}

function requestBody(messages: WireMessage[]) {
    return { model: "crow-0", stream: true, messages, tools: ["read", "edit", "grep"].map((name) => ({ type: "function", function: { name } })) };
}

async function completion(port: number, messages: WireMessage[]): Promise<{ call: ToolCall | null; finish: string | null }> {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody(messages)),
    });
    expect(response.ok).toBe(true);
    const chunks = (await response.text()).split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)) as Chunk);
    const first = chunks.flatMap((chunk) => chunk.choices[0]?.delta.tool_calls ?? []).find((call) => call.id !== undefined);
    return { call: first?.id && first.function?.name ? { id: first.id, name: first.function.name } : null,
        finish: chunks.findLast((chunk) => chunk.choices[0]?.finish_reason !== null)?.choices[0]?.finish_reason ?? null };
}

function appendCall(messages: WireMessage[], call: ToolCall): void {
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: "{}" } }] });
    messages.push({ role: "tool", tool_call_id: call.id, content: "Chart checked." });
}

async function scriptedTurn(compactAfter: number[]): Promise<ToolCall[]> {
    const server = startProvider({ seed: 1, speed: 1000 });
    const marker: WireMessage = { role: "user", content: "LOAD_TURN:crow-0000:0 Sail." };
    let messages = [marker];
    const calls: ToolCall[] = [];
    try {
        for (let i = 0; i < 14; i++) {
            const reply = await completion(server.port!, messages);
            if (reply.call === null) {
                expect(reply.finish).toBe("stop");
                return calls;
            }
            expect(reply.finish).toBe("tool_calls");
            expect(messages.flatMap((message) => message.tool_calls?.map((call) => call.id) ?? [])).not.toContain(reply.call.id);
            calls.push(reply.call);
            appendCall(messages, reply.call);
            if (compactAfter.includes(calls.length)) {
                messages = [marker, { role: "system", content: "Earlier voyage summarized." }, ...messages.slice(-4)];
            }
        }
        throw new Error("Scripted turn did not finish");
    } finally { server.stop(true); }
}

test("scripted tool calls keep their IDs and rounds through repeated compactions", async () => {
    const baseline = await scriptedTurn([]);
    const compacted = await scriptedTurn([4, 8]);
    const names = ["read", "edit", "grep"];
    expect(baseline).toEqual(Array.from({ length: 11 }, (_, round) => ({ id: `call-1462095147-${round}`, name: names[round % 3]! })));
    expect(compacted).toEqual(baseline);
    expect(new Set(compacted.map((call) => call.id)).size).toBe(compacted.length);
}, 10_000);

test("provider tracks turns separately and reserves a round for an aborted response", async () => {
    const server = startProvider({ seed: 1, speed: 1000 });
    const first: WireMessage[] = [{ role: "user", content: "LOAD_TURN:crow-0000:0 Sail." }];
    const second: WireMessage[] = [{ role: "user", content: "LOAD_TURN:crow-0001:0 Sail." }];
    try {
        const plain = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...requestBody(first), stream: false }),
        });
        const plainBody = await plain.json() as { choices: { finish_reason: string }[] };
        expect(plainBody.choices[0]?.finish_reason).toBe("stop");
        const a = await completion(server.port!, first);
        const b = await completion(server.port!, second);
        expect(a.call?.id).toBe("call-1462095147-0");
        expect(b.call?.id).toMatch(/^call-\d+-0$/);
        if (!a.call || !b.call) throw new Error("Missing scripted calls");
        appendCall(first, a.call);
        appendCall(second, b.call);
        expect((await completion(server.port!, second)).call?.id).toMatch(/^call-\d+-1$/);
        const controller = new AbortController();
        const aborted = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody(first)), signal: controller.signal,
        });
        controller.abort();
        await aborted.body?.cancel().catch(() => {});
        expect((await completion(server.port!, first)).call?.id).toBe("call-1462095147-2");
        for (let round = 1; round <= 5; round++) appendCall(first, { id: `call-1462095147-${round}`, name: "read" });
        expect((await completion(server.port!, first)).call?.id).toBe("call-1462095147-6");
    } finally { server.stop(true); }
}, 10_000);

test("provider logs unmarked requests with retained stub call IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "load-provider-"));
    const logPath = join(root, "provider.ndjson");
    let server: ReturnType<typeof startProvider> | undefined;
    try {
        server = startProvider({ seed: 1, speed: 1000, logPath });
        const messages: WireMessage[] = [{ role: "user", content: "LOAD_TURN:crow-0000:0 Sail." }];
        const first = await completion(server.port!, messages);
        if (!first.call) throw new Error("Missing scripted call");
        appendCall(messages, first.call);
        const assistantOnly = await completion(server.port!, [messages[1]!]);
        const resultOnly = await completion(server.port!, [messages[2]!]);
        const side = await completion(server.port!, [{ role: "user", content: "Summarize the voyage." }]);
        const continued = await completion(server.port!, messages);
        expect([assistantOnly.finish, resultOnly.finish, side.finish]).toEqual(["stop", "stop", "stop"]);
        expect([assistantOnly.call, resultOnly.call, side.call]).toEqual([null, null, null]);
        expect(continued.call?.id).toBe("call-1462095147-1");
        const requests = (await Bun.file(logPath).text()).trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.type === "request");
        expect(requests.map((row) => row.markerLost === true)).toEqual([false, true, true, false, false]);
        expect(requests.slice(1, 3).map((row) => row.scripted)).toEqual([false, false]);
    } finally {
        server?.stop(true);
        await rm(root, { recursive: true, force: true });
    }
}, 10_000);
