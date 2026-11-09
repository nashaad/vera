import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";

function call(id: string, path: unknown): ModelMessage {
    return {
        role: "assistant",
        content: [{ type: "tool_call", id, name: "read", input: { path } }],
        source: { provider: "test", api: "test", model: "crow" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

function result(id: string, toolName = "read"): ModelMessage {
    return {
        role: "tool_result",
        toolCallId: id,
        toolName,
        content: [{ type: "text", text: `Result for ${id}: reef and cove.` }],
        isError: false,
    };
}

function user(text: string): ModelMessage {
    return { role: "user", content: [{ type: "text", text }] };
}

export function syntheticMeasurementStages(): readonly (readonly ModelMessage[])[] {
    const initial: ModelMessage[] = [];
    for (let index = 0; index < 1_000; index += 1) {
        const id = `call-${index}`;
        initial.push(
            user(`Turn ${index}: chart the reef.`),
            call(id, index % 2 === 0
                ? `/workspace/maps/chart-${index}.ts`
                : `C:\\charts\\chart-${index}.ts`),
            result(id),
        );
    }
    initial.push(
        result("future"),
        call("future", "  /charts/next.md  "),
        call("duplicate", 3),
        call("duplicate", "/charts/ignored.md"),
        result("duplicate"),
        call("unsafe", "/charts/"),
        result("unsafe", "../bad"),
        result("missing"),
    );
    return [
        initial,
        [...initial, user("A later turn"), call("appended", "/maps/new.md"), result("appended")],
        [...initial.slice(0, 2_400), user("Another branch"), call("call-999", "/maps/branch.md"), result("call-999")],
        initial.slice(0, 1_500),
        [user("Compacted history"), ...initial.slice(2_700)],
    ];
}
