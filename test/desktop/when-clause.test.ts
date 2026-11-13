import { expect, test } from "bun:test";

import {
    evaluateWhen,
    isWhenError,
    parseWhen,
    type WhenContext,
    type WhenError,
    type WhenExpression,
} from "../../clients/ui/src/extensions/when.ts";

type Entries = Record<string, string | number | boolean | undefined>;

function context(entries: Entries = {}): WhenContext {
    return new Map(Object.entries(entries));
}

function parsed(source: string): WhenExpression {
    const result = parseWhen(source);
    if (isWhenError(result)) throw new Error(`${source}: ${result.message} at ${result.offset}`);
    return result;
}

function failure(source: string): WhenError {
    const result = parseWhen(source);
    if (!isWhenError(result)) throw new Error(`${source} parsed without an error`);
    return result;
}

function run(source: string, entries: Entries = {}): boolean {
    return evaluateWhen(parsed(source), context(entries));
}

test("empty and whitespace-only sources parse to true", () => {
    expect(parseWhen("")).toEqual({ kind: "true" });
    expect(parseWhen(" \t\n ")).toEqual({ kind: "true" });
    expect(run("")).toBe(true);
});

test("bare true and false literals", () => {
    expect(run("true")).toBe(true);
    expect(run("false")).toBe(false);
    expect(run("!false")).toBe(true);
});

test("a bare key is true for truthy values", () => {
    expect(run("a", { a: true })).toBe(true);
    expect(run("a", { a: "x" })).toBe(true);
    expect(run("a", { a: 2 })).toBe(true);
    expect(run("a", { a: -1 })).toBe(true);
});

test("a bare key is false for falsy values", () => {
    expect(run("a", { a: false })).toBe(false);
    expect(run("a", { a: "" })).toBe(false);
    expect(run("a", { a: 0 })).toBe(false);
    expect(run("a", { a: Number.NaN })).toBe(false);
    expect(run("a", { a: undefined })).toBe(false);
});

test("a missing key is false and its negation is true", () => {
    expect(run("missing")).toBe(false);
    expect(run("!missing")).toBe(true);
});

test("! negates and stacks", () => {
    expect(run("!a", { a: false })).toBe(true);
    expect(run("!a", { a: true })).toBe(false);
    expect(run("!!a", { a: true })).toBe(true);
});

test("&& binds tighter than ||", () => {
    expect(parsed("a || b && c")).toEqual({
        kind: "or",
        operands: [
            { kind: "key", name: "a" },
            { kind: "and", operands: [{ kind: "key", name: "b" }, { kind: "key", name: "c" }] },
        ],
    });
    expect(run("a || b && c", { a: true })).toBe(true);
    expect(run("a || b && c", { b: true })).toBe(false);
    expect(run("a || b && c", { b: true, c: true })).toBe(true);
});

test("! binds tighter than &&", () => {
    expect(parsed("!a && b")).toEqual({
        kind: "and",
        operands: [{ kind: "not", operand: { kind: "key", name: "a" } }, { kind: "key", name: "b" }],
    });
});

test("== binds tighter than &&", () => {
    expect(parsed("view == 'models' && open")).toEqual({
        kind: "and",
        operands: [{ kind: "equals", name: "view", value: "models" }, { kind: "key", name: "open" }],
    });
    expect(run("view == 'models' && open", { view: "models", open: true })).toBe(true);
    expect(run("view == 'models' && open", { view: "models", open: false })).toBe(false);
});

test("chains of the same operator stay flat", () => {
    expect(parsed("a || b || c")).toEqual({
        kind: "or",
        operands: [{ kind: "key", name: "a" }, { kind: "key", name: "b" }, { kind: "key", name: "c" }],
    });
    expect(parsed("a && b && c")).toEqual({
        kind: "and",
        operands: [{ kind: "key", name: "a" }, { kind: "key", name: "b" }, { kind: "key", name: "c" }],
    });
});

test("parentheses override precedence", () => {
    expect(run("(a || b) && c", { a: true })).toBe(false);
    expect(run("(a || b) && c", { a: true, c: true })).toBe(true);
    expect(run("a || (b && c)", { a: true })).toBe(true);
    expect(run("!(a || b)", {})).toBe(true);
    expect(run("((a))", { a: true })).toBe(true);
});

test("== compares strings, numbers and booleans strictly", () => {
    expect(run("view == 'models'", { view: "models" })).toBe(true);
    expect(run("view == 'models'", { view: "chat" })).toBe(false);
    expect(run("count == 3", { count: 3 })).toBe(true);
    expect(run("count == 3", { count: "3" })).toBe(false);
    expect(run("ok == true", { ok: true })).toBe(true);
    expect(run("ok == false", { ok: true })).toBe(false);
    expect(run("ok == 1", { ok: true })).toBe(false);
});

test("!= is the negation for present values", () => {
    expect(run("view != 'models'", { view: "chat" })).toBe(true);
    expect(run("view != 'models'", { view: "models" })).toBe(false);
    expect(run("count != 3", { count: "3" })).toBe(true);
    expect(run("ok != true", { ok: false })).toBe(true);
});

test("a missing key equals nothing and differs from everything", () => {
    expect(run("view == 'models'")).toBe(false);
    expect(run("view != 'models'")).toBe(true);
    expect(run("view == 0")).toBe(false);
    expect(run("view == false")).toBe(false);
    expect(run("view == ''")).toBe(false);
    expect(run("view == ''", { view: "" })).toBe(true);
});

test("string escapes", () => {
    expect(parsed("v == 'it\\'s'")).toEqual({ kind: "equals", name: "v", value: "it's" });
    expect(run("v == 'it\\'s'", { v: "it's" })).toBe(true);
    expect(parsed("v == 'a\\\\b'")).toEqual({ kind: "equals", name: "v", value: "a\\b" });
    expect(parsed("v == ''")).toEqual({ kind: "equals", name: "v", value: "" });
});

test("numbers and booleans on the right side", () => {
    expect(parsed("n == -2")).toEqual({ kind: "equals", name: "n", value: -2 });
    expect(run("n == 1.5", { n: 1.5 })).toBe(true);
    expect(run("n == 0", { n: 0 })).toBe(true);
    expect(parsed("n != false")).toEqual({ kind: "notEquals", name: "n", value: false });
});

test("identifiers may contain dots, dashes and underscores", () => {
    expect(run("vera.sessionOpen", { "vera.sessionOpen": true })).toBe(true);
    expect(run("my-key_2 == 'x'", { "my-key_2": "x" })).toBe(true);
    expect(run("_x", { _x: 1 })).toBe(true);
});

test("whitespace between tokens is optional", () => {
    expect(run("  a&&b  ", { a: 1, b: 1 })).toBe(true);
    expect(run("a==1", { a: 1 })).toBe(true);
});

test("every error result has kind, message and offset", () => {
    const result = failure("a = 'x'");
    expect(result.kind).toBe("error");
    expect(result.message).toBe("use == for equality");
    expect(result.offset).toBe(2);
});

test("unexpected end of input reports the end offset", () => {
    expect(failure("a &&").offset).toBe(4);
    expect(failure("a == 'x' ||").offset).toBe(11);
    expect(failure("(").offset).toBe(1);
});

test("unsupported operators are refused with their offset", () => {
    expect(failure("a = 'x'").offset).toBe(2);
    expect(failure("a & b").offset).toBe(2);
    expect(failure("a | b").offset).toBe(2);
    expect(failure("a ~ 'x'").offset).toBe(2);
    expect(failure("a =~ 'x'").message).toBe("regex matching is not supported");
    expect(failure("a =~ 'x'").offset).toBe(2);
    expect(failure("a < 3").offset).toBe(2);
    expect(failure("a > 3").offset).toBe(2);
    expect(failure("a / b").offset).toBe(2);
    expect(failure("a == -").offset).toBe(5);
    expect(failure("$a").offset).toBe(0);
});

test("in is refused", () => {
    const result = failure("a in b");
    expect(result.message).toBe("the 'in' operator is not supported");
    expect(result.offset).toBe(2);
    expect(failure("a && in").offset).toBe(5);
});

test("a bare identifier on the right side of == is an error", () => {
    expect(failure("a == b").offset).toBe(5);
    expect(failure("a == b").message).toBe("right side of == or != must be a quoted string, number, true or false");
    expect(failure("a ==").offset).toBe(4);
});

test("the left side of == must be a key", () => {
    expect(failure("!a == 'x'").offset).toBe(0);
    expect(failure("'x' == a").offset).toBe(0);
    expect(failure("(a == 'x') == 'y'").offset).toBe(0);
});

test("a second comparison without && is an error", () => {
    expect(failure("a == 'x' == 'y'").offset).toBe(9);
});

test("a leading operator is an error", () => {
    expect(failure("== 'x'").offset).toBe(0);
});

test("unbalanced parentheses", () => {
    expect(failure("(a").message).toBe("missing closing parenthesis");
    expect(failure("(a").offset).toBe(0);
    expect(failure("a)").offset).toBe(1);
    expect(failure("()").offset).toBe(1);
});

test("unterminated strings report the opening quote", () => {
    expect(failure("'abc").offset).toBe(0);
    expect(failure("a == 'x").offset).toBe(5);
});

test("double-quoted strings compare like single-quoted ones", () => {
    expect(parsed('view == "models"')).toEqual({ kind: "equals", name: "view", value: "models" });
    expect(run('view == "models"', { view: "models" })).toBe(true);
    expect(run('view != "models"', { view: "chat" })).toBe(true);
    expect(parsed('v == "say \\"hi\\""')).toEqual({ kind: "equals", name: "v", value: 'say "hi"' });
    expect(parsed("v == \"it's\"")).toEqual({ kind: "equals", name: "v", value: "it's" });
    expect(parsed("v == 'say \"hi\"'")).toEqual({ kind: "equals", name: "v", value: 'say "hi"' });
});

test("a string escapes only its own quote character", () => {
    expect(failure("v == 'a\\\"b'").offset).toBe(7);
    expect(failure('v == "a\\\'b"').offset).toBe(7);
    expect(failure('v == "unterminated').offset).toBe(5);
});

test("invalid string escapes", () => {
    expect(failure("v == 'a\\nb'").offset).toBe(7);
    expect(failure("v == 'a\\nb'").message).toBe("only \\' and \\\\ may be escaped");
});

test("!= followed by = is an error", () => {
    expect(failure("a !== 'x'").offset).toBe(4);
});

test("a number directly followed by a word is an error", () => {
    expect(failure("1x").offset).toBe(0);
});

test("a second word after a key is an error", () => {
    expect(failure("a.b c").offset).toBe(4);
    expect(failure("a == 1 2").offset).toBe(7);
});

test("sources up to 1000 characters parse", () => {
    const exact = ("a" + " || a".repeat(199)).padEnd(1000);
    expect(exact.length).toBe(1000);
    expect(isWhenError(parseWhen(exact))).toBe(false);
});

test("sources over 1000 characters are an error at offset 1000", () => {
    const result = failure("a".padEnd(1001));
    expect(result.offset).toBe(1000);
    expect(result.message).toContain("1000");
});

test("nesting up to 32 parses", () => {
    const source = "(".repeat(32) + "a" + ")".repeat(32);
    expect(run(source, { a: true })).toBe(true);
    expect(run("!".repeat(32) + "a", { a: true })).toBe(true);
});

test("nesting deeper than 32 is an error at the 33rd opener", () => {
    const parens = "(".repeat(33) + "a" + ")".repeat(33);
    expect(failure(parens).offset).toBe(32);
    expect(failure(parens).message).toContain("32");
    expect(failure("!".repeat(33) + "a").offset).toBe(32);
});

test("one parsed tree gives the same result on every evaluation", () => {
    const expression = parsed("vera.sessionOpen && !busy || view == 'models'");
    for (let i = 0; i < 1000; i++) {
        const ctx = context({
            "vera.sessionOpen": i % 2 === 0,
            busy: i % 3 === 0,
            view: i % 5 === 0 ? "models" : "chat",
        });
        const expected = (i % 2 === 0 && i % 3 !== 0) || i % 5 === 0;
        expect(evaluateWhen(expression, ctx)).toBe(expected);
        expect(evaluateWhen(expression, ctx)).toBe(expected);
    }
});

test("isWhenError tells errors from expressions", () => {
    expect(isWhenError(parseWhen("a"))).toBe(false);
    expect(isWhenError(parseWhen("a ="))).toBe(true);
});
