import { expect, test } from "bun:test";

import { MAX_LOG_CHARS, MAX_TOAST_CHARS, MAX_VALUE_CHARS, type FromWorker } from "../../clients/ui/src/extensions/envelope.ts";
import { createVera, type Handler } from "../../clients/ui/src/extensions/sandbox/vera-api.ts";

function make() {
    const sent: FromWorker[] = [];
    const handlers = new Map<string, Handler>();
    const vera = createVera("demo", new Set(["demo.one", "demo.two"]), handlers, (message) => sent.push(message));
    return { vera, sent, handlers };
}

test("the handles are frozen", () => {
    const { vera } = make();
    expect(Object.isFrozen(vera)).toBe(true);
    expect(Object.isFrozen(vera.commands)).toBe(true);
    expect(Object.isFrozen(vera.window)).toBe(true);
    expect(Object.isFrozen(vera.output)).toBe(true);
    expect(Object.isFrozen(vera.context)).toBe(true);
    expect(Object.keys(vera).sort()).toEqual(["commands", "context", "output", "window"]);
});

test("@core only commands the manifest declares can be registered", () => {
    const { vera, handlers } = make();
    const handler = () => undefined;
    vera.commands.register("demo.one", handler);
    expect(handlers.get("demo.one")).toBe(handler);
    expect(() => vera.commands.register("demo.other", handler)).toThrow("not declared");
    expect(() => vera.commands.register("go.settings", handler)).toThrow("not declared");
    expect(() => vera.commands.register("demo.two", "nope" as unknown as Handler)).toThrow("must be a function");
    expect([...handlers.keys()]).toEqual(["demo.one"]);
});

test("toasts carry text and an optional tone, and bad ones throw", () => {
    const { vera, sent } = make();
    vera.window.showToast("hello");
    vera.window.showToast("done", "success");
    expect(sent).toEqual([{ type: "toast", text: "hello" }, { type: "toast", text: "done", tone: "success" }]);
    expect(() => vera.window.showToast("x".repeat(MAX_TOAST_CHARS + 1))).toThrow();
    expect(() => vera.window.showToast("x", "loud" as never)).toThrow();
    expect(() => vera.window.showToast(5 as never)).toThrow();
    expect(sent).toHaveLength(2);
});

test("output lines default to info, and bad ones throw", () => {
    const { vera, sent } = make();
    vera.output.appendLine("one");
    vera.output.appendLine("two", "warn");
    expect(sent).toEqual([{ type: "log", level: "info", text: "one" }, { type: "log", level: "warn", text: "two" }]);
    expect(() => vera.output.appendLine("x".repeat(MAX_LOG_CHARS + 1))).toThrow();
    expect(() => vera.output.appendLine("x", "debug" as never)).toThrow();
    expect(sent).toHaveLength(2);
});

test("@core an extension may set only keys that start with its own id and a dot", () => {
    const { vera, sent } = make();
    vera.context.set("demo.armed", true);
    vera.context.set("demo.count", 3);
    vera.context.set("demo.mode", "fast");
    vera.context.set("demo.armed", null);
    vera.context.set("demo.count");
    expect(sent).toEqual([
        { type: "context", key: "demo.armed", value: true },
        { type: "context", key: "demo.count", value: 3 },
        { type: "context", key: "demo.mode", value: "fast" },
        { type: "context", key: "demo.armed" },
        { type: "context", key: "demo.count" },
    ]);
    for (const key of ["view", "sessionBusy", "demo", "demo.", "demoer.armed", "other.armed", "", `demo.${"k".repeat(200)}`]) {
        expect(() => vera.context.set(key, true)).toThrow();
    }
    expect(sent).toHaveLength(5);
});

test("context values are booleans, finite numbers or short text", () => {
    const { vera, sent } = make();
    expect(() => vera.context.set("demo.a", Number.NaN)).toThrow();
    expect(() => vera.context.set("demo.a", Number.POSITIVE_INFINITY)).toThrow();
    expect(() => vera.context.set("demo.a", { nested: true } as never)).toThrow();
    expect(() => vera.context.set("demo.a", "x".repeat(MAX_VALUE_CHARS + 1))).toThrow();
    expect(sent).toHaveLength(0);
});
