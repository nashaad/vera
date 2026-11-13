type WhenValue = string | number | boolean;

interface TrueWhen {
    readonly kind: "true";
}

interface KeyWhen {
    readonly kind: "key";
    readonly name: string;
}

interface NotWhen {
    readonly kind: "not";
    readonly operand: WhenExpression;
}

interface AndWhen {
    readonly kind: "and";
    readonly operands: readonly WhenExpression[];
}

interface OrWhen {
    readonly kind: "or";
    readonly operands: readonly WhenExpression[];
}

interface EqualsWhen {
    readonly kind: "equals";
    readonly name: string;
    readonly value: WhenValue;
}

interface NotEqualsWhen {
    readonly kind: "notEquals";
    readonly name: string;
    readonly value: WhenValue;
}

export type WhenExpression = TrueWhen | KeyWhen | NotWhen | AndWhen | OrWhen | EqualsWhen | NotEqualsWhen;

export interface WhenError {
    readonly kind: "error";
    readonly message: string;
    readonly offset: number;
}

export type WhenContext = ReadonlyMap<string, string | number | boolean | undefined>;

const MAX_SOURCE_LENGTH = 1000;
const MAX_NESTING = 32;
const IDENT = /[A-Za-z_][A-Za-z0-9_.-]*/y;
const NUMBER = /-?[0-9]+(?:\.[0-9]+)?/y;

type TokenKind = "ident" | "string" | "number" | "op" | "end";

interface Token {
    readonly kind: TokenKind;
    readonly text: string;
    readonly offset: number;
    readonly literal?: WhenValue;
}

class ParseFailure extends Error {
    readonly offset: number;

    constructor(message: string, offset: number) {
        super(message);
        this.offset = offset;
    }
}

export function parseWhen(source: string): WhenExpression | WhenError {
    if (source.length > MAX_SOURCE_LENGTH) {
        return { kind: "error", message: `source is longer than ${MAX_SOURCE_LENGTH} characters`, offset: MAX_SOURCE_LENGTH };
    }
    if (source.trim() === "") return { kind: "true" };
    try {
        return new Parser(tokenize(source)).parse();
    } catch (error) {
        if (error instanceof ParseFailure) return { kind: "error", message: error.message, offset: error.offset };
        throw error;
    }
}

export function evaluateWhen(expression: WhenExpression, context: WhenContext): boolean {
    switch (expression.kind) {
        case "true":
            return true;
        case "key":
            return isTruthy(context.get(expression.name));
        case "not":
            return !evaluateWhen(expression.operand, context);
        case "and":
            return expression.operands.every((operand) => evaluateWhen(operand, context));
        case "or":
            return expression.operands.some((operand) => evaluateWhen(operand, context));
        case "equals":
            return context.get(expression.name) === expression.value;
        case "notEquals":
            // A missing key differs from every value, so != is true for it.
            return context.get(expression.name) !== expression.value;
    }
}

export function isWhenError(value: WhenExpression | WhenError): value is WhenError {
    return value.kind === "error";
}

function isTruthy(value: WhenValue | undefined): boolean {
    if (value === undefined) return false;
    if (typeof value === "boolean") return value;
    if (typeof value === "string") return value.length > 0;
    return value !== 0 && !Number.isNaN(value);
}

function matchAt(pattern: RegExp, source: string, index: number): string | null {
    pattern.lastIndex = index;
    const found = pattern.exec(source);
    return found ? found[0] : null;
}

function tokenize(source: string): Token[] {
    const tokens: Token[] = [];
    let index = 0;
    while (index < source.length) {
        const ch = source.charAt(index);
        if (/\s/.test(ch)) {
            index++;
            continue;
        }
        if (ch === "'" || ch === '"') {
            const { value, end } = readString(source, index);
            tokens.push({ kind: "string", text: source.slice(index, end), offset: index, literal: value });
            index = end;
            continue;
        }
        const word = matchAt(IDENT, source, index);
        if (word !== null) {
            tokens.push({ kind: "ident", text: word, offset: index });
            index += word.length;
            continue;
        }
        const digits = matchAt(NUMBER, source, index);
        if (digits !== null) {
            tokens.push({ kind: "number", text: digits, offset: index, literal: Number(digits) });
            index += digits.length;
            continue;
        }
        const pair = source.slice(index, index + 2);
        if (pair === "&&" || pair === "||" || pair === "==" || pair === "!=") {
            tokens.push({ kind: "op", text: pair, offset: index });
            index += 2;
            continue;
        }
        if (ch === "!" || ch === "(" || ch === ")") {
            tokens.push({ kind: "op", text: ch, offset: index });
            index++;
            continue;
        }
        throw new ParseFailure(unsupportedMessage(source, index), index);
    }
    tokens.push({ kind: "end", text: "", offset: source.length });
    return tokens;
}

function readString(source: string, start: number): { value: string; end: number } {
    const quote = source.charAt(start);
    let value = "";
    let index = start + 1;
    while (index < source.length) {
        const ch = source.charAt(index);
        if (ch === quote) return { value, end: index + 1 };
        if (ch === "\\") {
            const escaped = source.charAt(index + 1);
            if (escaped !== quote && escaped !== "\\") {
                throw new ParseFailure(`only \\${quote} and \\\\ may be escaped`, index);
            }
            value += escaped;
            index += 2;
            continue;
        }
        value += ch;
        index++;
    }
    throw new ParseFailure("unterminated string", start);
}

function unsupportedMessage(source: string, index: number): string {
    if (source.startsWith("=~", index)) return "regex matching is not supported";
    const ch = source.charAt(index);
    if (ch === "=") return "use == for equality";
    if (ch === "&") return "expected &&";
    if (ch === "|") return "expected ||";
    return `unsupported character '${ch}'`;
}

function unexpected(token: Token): ParseFailure {
    if (token.kind === "end") return new ParseFailure("unexpected end of expression", token.offset);
    if (token.kind === "ident" && token.text === "in") {
        return new ParseFailure("the 'in' operator is not supported", token.offset);
    }
    return new ParseFailure(`unexpected '${token.text}'`, token.offset);
}

class Parser {
    private readonly tokens: readonly Token[];
    private index = 0;
    private depth = 0;

    constructor(tokens: readonly Token[]) {
        this.tokens = tokens;
    }

    parse(): WhenExpression {
        const expression = this.or();
        const rest = this.peek();
        if (rest.kind !== "end") throw unexpected(rest);
        return expression;
    }

    private peek(): Token {
        const token = this.tokens[this.index];
        if (token === undefined) throw new Error("parser moved past the end token");
        return token;
    }

    private acceptOp(text: string): boolean {
        const token = this.peek();
        if (token.kind !== "op" || token.text !== text) return false;
        this.index++;
        return true;
    }

    private enter(offset: number): void {
        this.depth++;
        if (this.depth > MAX_NESTING) throw new ParseFailure(`nesting is deeper than ${MAX_NESTING}`, offset);
    }

    private or(): WhenExpression {
        const first = this.and();
        const rest: WhenExpression[] = [];
        while (this.acceptOp("||")) rest.push(this.and());
        return rest.length === 0 ? first : { kind: "or", operands: [first, ...rest] };
    }

    private and(): WhenExpression {
        const first = this.comparison();
        const rest: WhenExpression[] = [];
        while (this.acceptOp("&&")) rest.push(this.comparison());
        return rest.length === 0 ? first : { kind: "and", operands: [first, ...rest] };
    }

    private comparison(): WhenExpression {
        const start = this.peek();
        const left = this.unary();
        const op = this.peek();
        if (op.kind !== "op" || (op.text !== "==" && op.text !== "!=")) return left;
        this.index++;
        if (left.kind !== "key") throw new ParseFailure(`left side of ${op.text} must be a key name`, start.offset);
        const value = this.value();
        if (op.text === "==") return { kind: "equals", name: left.name, value };
        return { kind: "notEquals", name: left.name, value };
    }

    private value(): WhenValue {
        const token = this.peek();
        if (token.literal !== undefined) {
            this.index++;
            return token.literal;
        }
        if (token.kind === "ident" && (token.text === "true" || token.text === "false")) {
            this.index++;
            return token.text === "true";
        }
        throw new ParseFailure("right side of == or != must be a quoted string, number, true or false", token.offset);
    }

    private unary(): WhenExpression {
        const token = this.peek();
        if (token.kind !== "op" || token.text !== "!") return this.atom();
        this.index++;
        this.enter(token.offset);
        const operand = this.unary();
        this.depth--;
        return { kind: "not", operand };
    }

    private atom(): WhenExpression {
        const token = this.peek();
        if (token.kind === "op" && token.text === "(") {
            this.index++;
            this.enter(token.offset);
            const inner = this.or();
            if (!this.acceptOp(")")) throw new ParseFailure("missing closing parenthesis", token.offset);
            this.depth--;
            return inner;
        }
        if (token.kind === "ident" && token.text !== "in") {
            this.index++;
            if (token.text === "true") return { kind: "true" };
            if (token.text === "false") return { kind: "not", operand: { kind: "true" } };
            return { kind: "key", name: token.text };
        }
        throw unexpected(token);
    }
}
