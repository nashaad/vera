// @ts-nocheck
/**
 * Extract one partition file from module-scope functions in main.ts.
 * Run after the hoist: `bun run scripts/tui-codemod-extract.ts chrome.ts`
 */
const fs = require("node:fs");
const path = require("node:path");
const ts = require("/Users/nash/Projects/vera/node_modules/typescript/lib/typescript.js");
const { TUI_PARTITION } = require("./tui-partition.ts");

const MAIN = "clients/tui/main.ts";
const RUNTIME_TYPES = new Set([
    "TuiRuntime",
    "PoolChangeUndo",
    "TuiAgentCatalog",
    "TuiAgentCatalogRow",
]);
const MAIN_TYPES = new Set([
    "TuiDependencies",
    "TuiDraft",
    "TuiExit",
    "TuiStartOptions",
    "TuiStartTarget",
]);

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

function rewriteSpecFromMain(spec) {
    if (spec.startsWith(".")) {
        const joined = path.posix.normalize(`../${spec}`);
        return joined.startsWith(".") ? joined : `./${joined}`;
    }
    return spec;
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
    for (const r of sorted) out = out.slice(0, r.start) + r.text + out.slice(r.end);
    return out;
}

function addNamed(map, spec, name) {
    let set = map.get(spec);
    if (!set) {
        set = new Set();
        map.set(spec, set);
    }
    set.add(name);
}

function renderImports(valueBySpec, typeBySpec) {
    const specs = [...new Set([...valueBySpec.keys(), ...typeBySpec.keys()])].sort();
    const lines = [];
    for (const spec of specs) {
        const values = [...(valueBySpec.get(spec) ?? [])].sort();
        const types = [...(typeBySpec.get(spec) ?? [])].filter((n) => !values.includes(n)).sort();
        if (values.length > 0 && types.length > 0) {
            lines.push(
                `import { ${values.join(", ")}, ${types.map((n) => `type ${n}`).join(", ")} } from "${spec}";`,
            );
        } else if (values.length > 0) {
            lines.push(`import { ${values.join(", ")} } from "${spec}";`);
        } else if (types.length > 0) {
            lines.push(`import type { ${types.join(", ")} } from "${spec}";`);
        }
    }
    return lines.join("\n");
}

function isInTypePosition(node, root) {
    let n = node.parent;
    while (n && n !== root) {
        if (ts.isTypeQueryNode(n)) return false;
        if (ts.isTypeNode(n) || ts.isTypeElement(n)) return true;
        if (
            ts.isTypeAliasDeclaration(n)
            || ts.isInterfaceDeclaration(n)
            || ts.isHeritageClause(n)
        ) {
            return true;
        }
        n = n.parent;
    }
    return false;
}

function importInfo(symbol, checker) {
    if (!symbol) return null;
    const decls = symbol.declarations ?? [];
    for (const d of decls) {
        let n = d;
        while (n) {
            if (ts.isImportSpecifier(n)) {
                const decl = n.parent.parent.parent;
                if (ts.isImportDeclaration(decl) && ts.isStringLiteral(decl.moduleSpecifier)) {
                    const clause = n.parent.parent;
                    return {
                        spec: decl.moduleSpecifier.text,
                        local: n.name.text,
                        imported: (n.propertyName ?? n.name).text,
                        typeOnly: Boolean(clause.isTypeOnly || n.isTypeOnly),
                    };
                }
            }
            n = n.parent;
        }
    }
    return null;
}

const file = process.argv[2];
if (!file || !TUI_PARTITION[file]) {
    fail(`usage: bun run scripts/tui-codemod-extract.ts <${Object.keys(TUI_PARTITION).join("|")}>`);
}
const names = TUI_PARTITION[file];
const nameSet = new Set(names);

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

const fnDecls = new Map();
const allModuleFns = new Map();
for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        allModuleFns.set(stmt.name.text, stmt);
        if (nameSet.has(stmt.name.text)) fnDecls.set(stmt.name.text, stmt);
    }
}
const missing = names.filter((n) => !fnDecls.has(n));
if (missing.length) fail(`${file}: missing ${missing.join(", ")}`);

const moduleFnSymbols = new Map();
for (const [name, decl] of allModuleFns) {
    const symbol = checker.getSymbolAtLocation(decl.name);
    if (symbol) moduleFnSymbols.set(symbol, name);
}

const valueBySpec = new Map();
const typeBySpec = new Map();
addNamed(typeBySpec, "./runtime.ts", "TuiRuntime");

const pieces = [];
for (const name of names) {
    const fn = fnDecls.get(name);
    const start = fn.getStart(sf);
    const triviaStart = source.lastIndexOf("\n", start - 1) + 1;
    const text = source.slice(triviaStart, fn.getEnd()).replace(/^\n/, "");
    pieces.push(text.trimStart());

    function collect(node) {
        if (ts.isIdentifier(node)) {
            if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
                ts.forEachChild(node, collect);
                return;
            }
            if (ts.isFunctionDeclaration(node.parent) && node.parent.name === node) return;
            const symbol = checker.getSymbolAtLocation(node);
            if (!symbol) {
                ts.forEachChild(node, collect);
                return;
            }
            const other = moduleFnSymbols.get(symbol);
            if (other) {
                if (!nameSet.has(other)) addNamed(valueBySpec, "../main.ts", other);
                ts.forEachChild(node, collect);
                return;
            }
            if (RUNTIME_TYPES.has(node.text)) {
                addNamed(
                    isInTypePosition(node, fn) ? typeBySpec : valueBySpec,
                    "./runtime.ts",
                    node.text,
                );
                ts.forEachChild(node, collect);
                return;
            }
            if (MAIN_TYPES.has(node.text)) {
                addNamed(
                    isInTypePosition(node, fn) ? typeBySpec : valueBySpec,
                    "../main.ts",
                    node.text,
                );
                ts.forEachChild(node, collect);
                return;
            }
            const info = importInfo(symbol, checker);
            if (info) {
                const spec = rewriteSpecFromMain(info.spec);
                const bucket = (info.typeOnly || isInTypePosition(node, fn))
                    ? typeBySpec
                    : valueBySpec;
                addNamed(
                    bucket,
                    spec,
                    info.imported === info.local
                        ? info.local
                        : `${info.imported} as ${info.local}`,
                );
            }
        }
        ts.forEachChild(node, collect);
    }
    collect(fn);
}

const dest = path.join("clients/tui/main", file);
const imports = renderImports(valueBySpec, typeBySpec);
fs.writeFileSync(dest, `${imports}\n\n${pieces.join("\n\n")}\n`);

const replacements = [];
for (const fn of fnDecls.values()) {
    const start = source.lastIndexOf("\n", fn.getStart(sf) - 1) + 1;
    let end = fn.getEnd();
    if (source[end] === "\n") end += 1;
    replacements.push({ start, end, text: "" });
}

const lastImport = [...sf.statements].reverse().find((s) => ts.isImportDeclaration(s)
    || (ts.isExportDeclaration(s) && s.moduleSpecifier));
let insertAt;
if (lastImport) {
    insertAt = lastImport.getEnd();
    if (source[insertAt] === "\n") insertAt += 1;
} else {
    insertAt = 0;
}
const exported = names.join(", ");
replacements.push({
    start: insertAt,
    end: insertAt,
    text: `export { ${exported} } from "./main/${file}";\n`,
});

fs.writeFileSync(MAIN, applyReplacements(source, replacements));
console.log(`extracted ${names.length} functions to ${dest}`);
