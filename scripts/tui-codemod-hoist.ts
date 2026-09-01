// @ts-nocheck
/**
 * After Codemod 1: hoist every startTui function to module scope with `rt`
 * as its first parameter. That is what makes one-file extracts typecheck.
 * `bun run scripts/tui-codemod-hoist.ts`
 */
const fs = require("node:fs");
const ts = require("/Users/nash/Projects/vera/node_modules/typescript/lib/typescript.js");

const MAIN = "clients/tui/main.ts";

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

function applyReplacements(source, replacements) {
    const sorted = [...replacements].sort((a, b) => {
        if (b.start !== a.start) return b.start - a.start;
        return b.end - a.end;
    });
    for (let i = 0; i < sorted.length - 1; i++) {
        const a = sorted[i];
        const b = sorted[i + 1];
        if (a.start < b.end && a.end > b.start) {
            fail(`overlapping replacements at ${b.start}-${b.end} and ${a.start}-${a.end}`);
        }
    }
    let out = source;
    for (const r of sorted) {
        out = out.slice(0, r.start) + r.text + out.slice(r.end);
    }
    return out;
}

function outdent(text) {
    return text.replace(/^    /gm, "");
}

function wrapperFor(fn) {
    const names = [];
    for (const p of fn.parameters) {
        if (!ts.isIdentifier(p.name)) {
            return `(...args) => ${fn.name.text}(rt, ...args)`;
        }
        names.push(p.name.text);
    }
    if (names.length === 0) return `() => ${fn.name.text}(rt)`;
    return `(${names.join(", ")}) => ${fn.name.text}(rt, ${names.join(", ")})`;
}

const source = fs.readFileSync(MAIN, "utf8");
const prog = ts.createProgram([MAIN], {
    target: 99,
    module: 200,
    strict: true,
    skipLibCheck: true,
    moduleResolution: 100,
    allowImportingTsExtensions: true,
    noEmit: true,
});
const checker = prog.getTypeChecker();
const sf = prog.getSourceFile(MAIN);
const startTui = sf.statements.find(
    (s) => ts.isFunctionDeclaration(s) && s.name?.text === "startTui",
);
if (!startTui?.body) fail("missing startTui");

const fnDecls = [];
for (const stmt of startTui.body.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) fnDecls.push(stmt);
}
if (fnDecls.length === 0) fail("no nested functions to hoist");

const fnSymbols = new Map();
for (const decl of fnDecls) {
    const symbol = checker.getSymbolAtLocation(decl.name);
    if (!symbol) fail(`no symbol for ${decl.name.text}`);
    fnSymbols.set(symbol, decl);
}

const callOrRef = [];
function visit(node) {
    if (!ts.isIdentifier(node)) {
        ts.forEachChild(node, visit);
        return;
    }
    if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
        return;
    }
    const symbol = checker.getSymbolAtLocation(node);
    const fn = symbol ? fnSymbols.get(symbol) : undefined;
    if (!fn) {
        ts.forEachChild(node, visit);
        return;
    }
    const parent = node.parent;
    if (ts.isFunctionDeclaration(parent) && parent.name === node) return;
    if (ts.isCallExpression(parent) && parent.expression === node) {
        const insertAt = parent.arguments.pos;
        callOrRef.push({
            start: insertAt,
            end: insertAt,
            text: parent.arguments.length > 0 ? "rt, " : "rt",
        });
        return;
    }
    callOrRef.push({
        start: node.getStart(sf),
        end: node.getEnd(),
        text: wrapperFor(fn),
    });
}
visit(startTui.body);

const hoisted = [];
for (const fn of fnDecls) {
    const fnStart = fn.getStart(sf);
    const fnEnd = fn.getEnd();
    const triviaStart = source.lastIndexOf("\n", fnStart - 1) + 1;
    const trivia = source.slice(triviaStart, fnStart);
    let text = source.slice(fnStart, fnEnd);
    const local = callOrRef
        .filter((r) => r.start >= fnStart && r.end <= fnEnd)
        .map((r) => ({ ...r, start: r.start - fnStart, end: r.end - fnStart }));
    const paren = source.indexOf("(", fn.name.getEnd());
    if (paren < 0 || paren > fnEnd) fail(`no param list for ${fn.name.text}`);
    local.push({
        start: paren - fnStart + 1,
        end: paren - fnStart + 1,
        text: fn.parameters.length > 0 ? "rt: TuiRuntime, " : "rt: TuiRuntime",
    });
    text = applyReplacements(text, local);
    if (!text.startsWith("export ")) text = `export ${text}`;
    hoisted.push(outdent(`${trivia}${text}`.replace(/^\s+/, "")));
}

const mainReplacements = [];
for (const fn of fnDecls) {
    const start = source.lastIndexOf("\n", fn.getStart(sf) - 1) + 1;
    let end = fn.getEnd();
    if (source[end] === "\n") end += 1;
    mainReplacements.push({ start, end, text: "" });
}
for (const r of callOrRef) {
    const inside = fnDecls.some((fn) => r.start >= fn.getStart(sf) && r.end <= fn.getEnd());
    if (!inside) mainReplacements.push(r);
}

let next = applyReplacements(source, mainReplacements);
if (!next.endsWith("\n")) next += "\n";
next += "\n" + hoisted.join("\n\n") + "\n";
fs.writeFileSync(MAIN, next);
console.log(`hoisted ${fnDecls.length} functions to module scope`);
