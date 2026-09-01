// @ts-nocheck
/**
 * Codemod 1: bind every startTui body declaration onto an explicit `rt` record.
 * Run once from the worktree root: `bun run scripts/tui-codemod-rt.ts`
 */
const fs = require("node:fs");
const path = require("node:path");
const ts = require("/Users/nash/Projects/vera/node_modules/typescript/lib/typescript.js");

const MAIN = "clients/tui/main.ts";
const RUNTIME = "clients/tui/main/runtime.ts";
const ROOT = process.cwd();

const TYPE_KEYWORDS = new Set([
    "readonly", "number", "string", "boolean", "undefined", "void", "never",
    "unknown", "any", "null", "true", "false", "typeof", "keyof", "infer",
    "const", "unique", "symbol", "asserts", "is", "in", "out", "extends",
    "object", "bigint", "this", "type", "from",
]);

const GLOBAL_TYPE_NAMES = new Set([
    "Map", "Set", "WeakMap", "WeakSet", "Promise", "Array", "ReadonlyArray",
    "Record", "Readonly", "ReadonlyMap", "ReadonlySet", "NonNullable",
    "ReturnType", "Partial", "Required", "Pick", "Omit", "Exclude", "Extract",
    "Awaited", "InstanceType", "Parameters", "ConstructorParameters",
    "ArrayBuffer", "Uint8Array", "Buffer", "NodeJS", "Date", "Error",
    "AbortController", "AbortSignal", "PromiseLike",
]);

const GLOBAL_VALUE_NAMES = new Set([
    "setInterval", "setTimeout", "clearInterval", "clearTimeout",
]);

interface Replacement {
    start: number;
    end: number;
    text: string;
}

interface Field {
    name: string;
    typeText: string;
    symbol: unknown;
    kind: "param" | "ident" | "destructure";
    stmt?: unknown;
    decl?: unknown;
}

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

function toRuntimeSpecifier(fromMain: string): string {
    if (fromMain.startsWith(".")) {
        const joined = path.posix.normalize(`../${fromMain}`);
        return joined.startsWith(".") ? joined : `./${joined}`;
    }
    return fromMain;
}

function absImportToSpecifier(absPath: string): string {
    const runtimeDir = path.join(ROOT, "clients/tui/main");
    let rel = path.relative(runtimeDir, absPath).replaceAll("\\", "/");
    if (!rel.startsWith(".")) rel = `./${rel}`;
    if (!rel.endsWith(".ts") && !rel.endsWith(".js") && !rel.endsWith(".tsx")) {
        rel += ".ts";
    }
    return rel;
}

function rewriteImportTypes(
    typeText: string,
    namedByModule: Map<string, Set<string>>,
): string {
    return typeText.replace(
        /import\("([^"]+)"\)\.([A-Za-z_][A-Za-z0-9_]*)/g,
        (_all, abs, name) => {
            const spec = absImportToSpecifier(abs);
            let set = namedByModule.get(spec);
            if (!set) {
                set = new Set();
                namedByModule.set(spec, set);
            }
            set.add(name);
            return name;
        },
    );
}

function alreadyImported(name: string, namedByModule: Map<string, Set<string>>): boolean {
    for (const set of namedByModule.values()) {
        if (set.has(name)) return true;
    }
    return false;
}

function typeIdentifiers(typeText: string): string[] {
    const stripped = typeText
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
        .replace(/"[^"]*"/g, "")
        .replace(/'[^']*'/g, "")
        .replace(/\bNodeJS\.[A-Za-z_][A-Za-z0-9_]*/g, "NodeJS");
    return [...stripped.matchAll(/\b[A-Z][A-Za-z0-9_]*\b/g)].map((m) => m[0]);
}

function isInTypePosition(node, startTui): boolean {
    let n = node.parent;
    while (n && n !== startTui) {
        // `typeof state` names the value; after the binding becomes a field
        // it has to read `typeof rt.state` or the type query is a missing name.
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

function applyReplacements(source: string, replacements: Replacement[]): string {
    const sorted = [...replacements].sort((a, b) => {
        if (b.start !== a.start) return b.start - a.start;
        return b.end - a.end;
    });
    for (let i = 0; i < sorted.length - 1; i++) {
        const a = sorted[i];
        const b = sorted[i + 1];
        // sorted descending; overlap if a.start < b.end && the later-in-file
        // range starts before the earlier one ends
        if (a.start < b.end && a.end > b.start) {
            fail(
                `overlapping replacements at ${b.start}-${b.end} and ${a.start}-${a.end}`,
            );
        }
    }
    let out = source;
    for (const r of sorted) {
        out = out.slice(0, r.start) + r.text + out.slice(r.end);
    }
    return out;
}

function collectMainImportMap(sf): {
    typeNameToSpec: Map<string, string>;
    valueNameToSpec: Map<string, string>;
} {
    const typeNameToSpec = new Map();
    const valueNameToSpec = new Map();
    for (const stmt of sf.statements) {
        if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
        if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
        const spec = stmt.moduleSpecifier.text;
        const clause = stmt.importClause;
        if (clause.name) {
            valueNameToSpec.set(clause.name.text, spec);
        }
        const named = clause.namedBindings;
        if (named && ts.isNamedImports(named)) {
            for (const el of named.elements) {
                const name = el.name.text;
                if (clause.isTypeOnly || el.isTypeOnly) {
                    typeNameToSpec.set(name, spec);
                } else {
                    valueNameToSpec.set(name, spec);
                    typeNameToSpec.set(name, spec);
                }
            }
        }
    }
    return { typeNameToSpec, valueNameToSpec };
}

function collectLocalTypeNames(sf): Set<string> {
    const names = new Set();
    for (const stmt of sf.statements) {
        if (
            (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt))
            && stmt.name
        ) {
            names.add(stmt.name.text);
        }
        if (ts.isExportDeclaration(stmt) && stmt.exportClause
            && ts.isNamedExports(stmt.exportClause)) {
            for (const el of stmt.exportClause.elements) {
                names.add(el.name.text);
            }
        }
    }
    return names;
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
if (!sf) fail("missing clients/tui/main.ts");

const startTui = sf.statements.find(
    (s) => ts.isFunctionDeclaration(s) && s.name?.text === "startTui",
);
if (!startTui?.body) fail("missing startTui");
if (startTui.parameters.length !== 1) {
    fail(`expected 1 startTui parameter, got ${startTui.parameters.length}`);
}

const depParam = startTui.parameters[0];
if (!ts.isIdentifier(depParam.name) || depParam.name.text !== "dependencies") {
    fail("startTui parameter is not `dependencies`");
}
const depSymbol = checker.getSymbolAtLocation(depParam.name);
if (!depSymbol) fail("no symbol for dependencies parameter");

const fields: Field[] = [{
    name: "dependencies",
    typeText: "TuiDependencies",
    symbol: depSymbol,
    kind: "param",
}];

const collectedSymbols = new Set([depSymbol]);
const identDecls: Field[] = [];
let destructureStmt = null;
const destructureFields: Field[] = [];

for (const stmt of startTui.body.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    if (stmt.declarationList.declarations.length !== 1) {
        fail(
            `multiple declarators at ${sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1}`,
        );
    }
    const d = stmt.declarationList.declarations[0];
    if (ts.isIdentifier(d.name)) {
        const symbol = checker.getSymbolAtLocation(d.name);
        if (!symbol) fail(`no symbol for ${d.name.text}`);
        const typeText = d.type
            ? d.type.getText(sf)
            : checker.typeToString(
                checker.getTypeAtLocation(d.name),
                d,
                ts.TypeFormatFlags.NoTruncation,
            );
        if (typeText === "any") {
            fail(`field type is any: ${d.name.text}`);
        }
        const field: Field = {
            name: d.name.text,
            typeText,
            symbol,
            kind: "ident",
            stmt,
            decl: d,
        };
        fields.push(field);
        identDecls.push(field);
        collectedSymbols.add(symbol);
        continue;
    }
    if (ts.isObjectBindingPattern(d.name)) {
        if (destructureStmt) fail("more than one destructuring declaration");
        destructureStmt = stmt;
        for (const el of d.name.elements) {
            if (el.dotDotDotToken) fail("rest in composer destructure");
            if (!ts.isIdentifier(el.name)) fail("nested destructure");
            const symbol = checker.getSymbolAtLocation(el.name);
            if (!symbol) fail(`no symbol for ${el.name.text}`);
            const typeText = checker.typeToString(
                checker.getTypeAtLocation(el.name),
                el,
                ts.TypeFormatFlags.NoTruncation,
            );
            if (typeText === "any") fail(`field type is any: ${el.name.text}`);
            const field: Field = {
                name: el.name.text,
                typeText,
                symbol,
                kind: "destructure",
                stmt,
                decl: el,
            };
            fields.push(field);
            destructureFields.push(field);
            collectedSymbols.add(symbol);
        }
        continue;
    }
    fail(`unhandled declaration: ${d.name.getText(sf)}`);
}

function stripTypeComments(typeText: string): string {
    return typeText
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n");
}

const namedByModule = new Map();
const rewrittenTypes = fields.map((f) => ({
    ...f,
    typeText: rewriteImportTypes(stripTypeComments(f.typeText), namedByModule),
}));

const { typeNameToSpec, valueNameToSpec } = collectMainImportMap(sf);
const localTypeNames = collectLocalTypeNames(sf);
const MAIN_DEFINED = new Set(["TuiDependencies", "TuiDraft", "TuiExit", "TuiStartOptions"]);
const definedHere = new Set([
    "PoolChangeUndo",
    "TuiRuntime",
    "TuiAgentCatalog",
    "TuiAgentCatalogRow",
]);

const unresolved = new Set();
const valueImports = new Map();

for (const field of rewrittenTypes) {
    for (const id of typeIdentifiers(field.typeText)) {
        if (TYPE_KEYWORDS.has(id) || GLOBAL_TYPE_NAMES.has(id)) continue;
        if (GLOBAL_VALUE_NAMES.has(id)) continue;
        if (definedHere.has(id)) continue;
        if (id === field.name) continue;
        if (alreadyImported(id, namedByModule)) continue;
        let spec = typeNameToSpec.get(id) ?? valueNameToSpec.get(id);
        if (!spec && localTypeNames.has(id) && MAIN_DEFINED.has(id)) {
            spec = "../main.ts";
        } else if (!spec && id === "TuiAgentClient") {
            spec = "../agent-client.ts";
        } else if (spec) {
            spec = spec === "../main.ts" ? spec : toRuntimeSpecifier(spec);
        }
        if (!spec) {
            unresolved.add(id);
            continue;
        }
        let set = namedByModule.get(spec);
        if (!set) {
            set = new Set();
            namedByModule.set(spec, set);
        }
        set.add(id);
    }
    for (const match of field.typeText.matchAll(/typeof\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
        const valueName = match[1];
        if (GLOBAL_VALUE_NAMES.has(valueName)) continue;
        const spec = valueNameToSpec.get(valueName);
        if (!spec) {
            unresolved.add(`typeof ${valueName}`);
            continue;
        }
        const runtimeSpec = toRuntimeSpecifier(spec);
        let set = valueImports.get(runtimeSpec);
        if (!set) {
            set = new Set();
            valueImports.set(runtimeSpec, set);
        }
        set.add(valueName);
    }
}

if (unresolved.size > 0) {
    fail(`unresolved field types:\n${[...unresolved].sort().join("\n")}`);
}

let poolChangeUndoText = "";
let poolChangeUndoStmt = null;
for (const stmt of startTui.body.statements) {
    if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === "PoolChangeUndo") {
        poolChangeUndoStmt = stmt;
        poolChangeUndoText = stmt.getText(sf)
            .replace(/^interface /, "export interface ")
            .replace(/\n    /g, "\n");
    }
}
if (!poolChangeUndoText) fail("PoolChangeUndo not found");

const movedAliases = [];
for (const stmt of sf.statements) {
    if (
        ts.isTypeAliasDeclaration(stmt)
        && (stmt.name.text === "TuiAgentCatalog" || stmt.name.text === "TuiAgentCatalogRow")
    ) {
        movedAliases.push({
            stmt,
            text: source.slice(stmt.getFullStart(), stmt.getEnd()).trim()
                .replace(/\btype /, "export type "),
        });
    }
}
if (movedAliases.length !== 2) {
    fail(`expected TuiAgentCatalog aliases, found ${movedAliases.length}`);
}
{
    const spec = "../../../src/engine/protocol.ts";
    let set = namedByModule.get(spec);
    if (!set) {
        set = new Set();
        namedByModule.set(spec, set);
    }
    set.add("AgentCatalogUpdate");
}

const importLines = [];
const allModules = new Set([...namedByModule.keys(), ...valueImports.keys()]);
for (const spec of [...allModules].sort()) {
    const types = [...(namedByModule.get(spec) ?? [])].sort();
    const values = [...(valueImports.get(spec) ?? [])].sort();
    if (values.length > 0 && types.length > 0) {
        const typePart = types.map((n) => `type ${n}`).join(", ");
        importLines.push(
            `import { ${values.join(", ")}, ${typePart} } from "${spec}";`,
        );
    } else if (values.length > 0) {
        importLines.push(`import { ${values.join(", ")} } from "${spec}";`);
    } else if (types.length > 0) {
        importLines.push(`import type { ${types.join(", ")} } from "${spec}";`);
    }
}

const fieldLines = rewrittenTypes.map((f) => `    ${f.name}: ${f.typeText};`);
const runtimeSource = `${importLines.join("\n")}

${movedAliases.map((a) => a.text).join("\n")}

${poolChangeUndoText}

export interface TuiRuntime {
${fieldLines.join("\n")}
}
`;

fs.mkdirSync(path.dirname(RUNTIME), { recursive: true });
fs.writeFileSync(RUNTIME, runtimeSource);
console.log(`wrote ${RUNTIME} (${rewrittenTypes.length} fields, ${importLines.length} imports)`);

const replacements: Replacement[] = [];

const lastImport = [...sf.statements].reverse().find((s) => ts.isImportDeclaration(s));
if (!lastImport) fail("no import to insert after");
let importInsert = lastImport.getEnd();
if (source[importInsert] === "\n") importInsert += 1;
replacements.push({
    start: importInsert,
    end: importInsert,
    text: `import { type PoolChangeUndo, type TuiAgentCatalog, type TuiAgentCatalogRow, type TuiRuntime } from "./main/runtime.ts";\n`,
});

const firstStmt = startTui.body.statements[0];
replacements.push({
    start: firstStmt.getFullStart(),
    end: firstStmt.getFullStart(),
    text: `\n    const rt = { dependencies } as TuiRuntime;\n`,
});

for (const field of identDecls) {
    const stmt = field.stmt;
    const d = field.decl;
    if (!d.initializer) {
        const start = stmt.getStart(sf);
        const lineStart = source.lastIndexOf("\n", start - 1) + 1;
        let end = stmt.getEnd();
        if (source[end] === "\r") end += 1;
        if (source[end] === "\n") end += 1;
        replacements.push({ start: lineStart, end, text: "" });
        continue;
    }
    const replaceEnd = d.type ? d.type.getEnd() : d.name.getEnd();
    replacements.push({
        start: stmt.getStart(sf),
        end: replaceEnd,
        text: `rt.${field.name}`,
    });
}

if (!destructureStmt) fail("destructuring declaration not found");
let destInsert = destructureStmt.getEnd();
if (source[destInsert] === "\n") destInsert += 1;
const destAssigns = destructureFields
    .map((f) => `    rt.${f.name} = ${f.name};\n`)
    .join("");
replacements.push({ start: destInsert, end: destInsert, text: destAssigns });

const destBindingNames = new Set(destructureFields.map((f) => f.name));
const skipDeclNames = new Set(identDecls.map((f) => f.decl.name));

function shouldRewrite(node): boolean {
    if (!ts.isIdentifier(node)) return false;
    if (isInTypePosition(node, startTui)) return false;
    const parent = node.parent;
    if (ts.isFunctionDeclaration(parent) && parent.name === node) return false;
    if (ts.isFunctionExpression(parent) && parent.name === node) return false;
    if (ts.isInterfaceDeclaration(parent) && parent.name === node) return false;
    if (parent && ts.isBindingElement(parent) && parent.name === node
        && destBindingNames.has(node.text)) {
        return false;
    }
    if (parent && ts.isVariableDeclaration(parent) && parent.name === node) {
        return false;
    }
    const symbol = (
        ts.isShorthandPropertyAssignment(parent) && parent.name === node
            ? checker.getShorthandAssignmentValueSymbol(parent)
            : undefined
    ) ?? checker.getSymbolAtLocation(node);
    if (!symbol || !collectedSymbols.has(symbol)) return false;
    return true;
}

function visit(node): void {
    if (node === poolChangeUndoStmt) return;
    if (ts.isIdentifier(node) && shouldRewrite(node)) {
        const parent = node.parent;
        if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
            replacements.push({
                start: node.getStart(sf),
                end: node.getEnd(),
                text: `${node.text}: rt.${node.text}`,
            });
        } else if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
            // property name, not a free variable
        } else {
            replacements.push({
                start: node.getStart(sf),
                end: node.getEnd(),
                text: `rt.${node.text}`,
            });
        }
    }
    ts.forEachChild(node, visit);
}
visit(startTui.body);

if (poolChangeUndoStmt) {
    const start = poolChangeUndoStmt.getStart(sf);
    const lineStart = source.lastIndexOf("\n", start - 1) + 1;
    let end = poolChangeUndoStmt.getEnd();
    if (source[end] === "\n") end += 1;
    replacements.push({ start: lineStart, end, text: "" });
}

for (const alias of movedAliases) {
    const start = alias.stmt.getStart(sf);
    const lineStart = source.lastIndexOf("\n", start - 1) + 1;
    let end = alias.stmt.getEnd();
    if (source[end] === "\n") end += 1;
    replacements.push({ start: lineStart, end, text: "" });
}

const next = applyReplacements(source, replacements);
fs.writeFileSync(MAIN, next);
console.log(`rewrote ${MAIN} (${replacements.length} replacements)`);
console.log(`shorthand expansions: ${
    replacements.filter((r) => r.text.includes(": rt.")).length
}`);
