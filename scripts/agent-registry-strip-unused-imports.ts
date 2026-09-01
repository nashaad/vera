// @ts-nocheck
/** Strip unused imports from AgentRegistry modules the lift created or thinned. */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const ts = require("/Users/nash/Projects/vera/node_modules/typescript/lib/typescript.js");

const TARGETS = new Set([
    "src/host/agent-registry.ts",
    "src/host/agent-registry/lifecycle.ts",
    "src/host/agent-registry/settings.ts",
    "src/host/agent-registry/wear.ts",
    "src/host/agent-registry/roster.ts",
    "src/host/agent-registry/subagent.ts",
]);

const result = spawnSync(
    "bun",
    ["x", "tsc", "--noUnusedLocals", "--noEmit", "--pretty", "false"],
    { encoding: "utf8" },
);
const out = `${result.stdout}\n${result.stderr}`;
const unused = new Map();
for (const line of out.split("\n")) {
    const match = line.match(
        /^(src\/host\/agent-registry(?:\.ts|\/[a-z]+\.ts))\(\d+,\d+\): error TS(?:6133|6192|6196): (?:'([^']+)' is declared but its value is never read\.|'([^']+)' is declared but never used\.|All imports in import declaration are unused\.)/,
    );
    if (!match) continue;
    const [, file, nameA, nameB] = match;
    if (!TARGETS.has(file)) continue;
    let set = unused.get(file);
    if (!set) {
        set = new Set();
        unused.set(file, set);
    }
    if (nameA || nameB) set.add(nameA ?? nameB);
    else set.add("*");
}

if (unused.size === 0) {
    console.log("no unused registry imports");
    process.exit(0);
}

function apply(source, replacements) {
    const sorted = [...replacements].sort((a, b) => b.start - a.start);
    let out = source;
    for (const r of sorted) out = out.slice(0, r.start) + r.text + out.slice(r.end);
    return out;
}

for (const [file, names] of unused) {
    const source = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const replacements = [];
    for (const stmt of sf.statements) {
        if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
        const namedBindings = stmt.importClause.namedBindings;
        if (namedBindings && ts.isNamespaceImport(namedBindings)) continue;
        const clause = stmt.importClause;
        const named = clause.namedBindings;
        const dropAll = names.has("*");
        if (named && ts.isNamedImports(named)) {
            const keep = named.elements.filter((el) => !names.has(el.name.text));
            const defaultKeep = clause.name && !names.has(clause.name.text);
            if (keep.length === named.elements.length && !dropAll && defaultKeep !== false) {
                if (!clause.name || defaultKeep) continue;
            }
            if (keep.length === 0 && !defaultKeep) {
                const start = source.lastIndexOf("\n", stmt.getStart(sf) - 1) + 1;
                let end = stmt.getEnd();
                if (source[end] === "\n") end += 1;
                replacements.push({ start, end, text: "" });
                continue;
            }
            const spec = stmt.moduleSpecifier.getText(sf);
            const typeOnly = clause.isTypeOnly;
            const parts = keep.map((el) => {
                const prefix = el.isTypeOnly ? "type " : "";
                if (el.propertyName) return `${prefix}${el.propertyName.text} as ${el.name.text}`;
                return `${prefix}${el.name.text}`;
            });
            const keyword = typeOnly ? "import type" : "import";
            const start = stmt.getStart(sf);
            let end = stmt.getEnd();
            const def = defaultKeep ? `${clause.name.text}, ` : "";
            replacements.push({
                start,
                end,
                text: `${keyword} { ${def}${parts.join(", ")} } from ${spec}`,
            });
            continue;
        }
        if (dropAll || (clause.name && names.has(clause.name.text) && !named)) {
            const start = source.lastIndexOf("\n", stmt.getStart(sf) - 1) + 1;
            let end = stmt.getEnd();
            if (source[end] === "\n") end += 1;
            replacements.push({ start, end, text: "" });
        }
    }
    fs.writeFileSync(file, apply(source, replacements));
    console.log(`${file}: removed ${[...names].join(", ")}`);
}
