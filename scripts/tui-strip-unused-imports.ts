// @ts-nocheck
/**
 * Delete exactly the unused imports tsc --noUnusedLocals names in
 * clients/tui/main.ts and clients/tui/main/*.ts. Nothing else.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("/Users/nash/Projects/vera/node_modules/typescript/lib/typescript.js");

const result = spawnSync(
    "bun",
    ["x", "tsc", "--noUnusedLocals", "--noEmit", "--pretty", "false"],
    { encoding: "utf8" },
);
const out = `${result.stdout}\n${result.stderr}`;
const unused = new Map();
for (const line of out.split("\n")) {
    const match = line.match(
        /^(clients\/tui\/(?:main\.ts|main\/[\w.-]+\.ts|settings-picker[\w.-]*\.ts))\(\d+,\d+\): error TS6133: '([^']+)' is declared but its value is never read\./,
    );
    if (!match) continue;
    const [, file, name] = match;
    let set = unused.get(file);
    if (!set) {
        set = new Set();
        unused.set(file, set);
    }
    set.add(name);
}

if (unused.size === 0) {
    console.log("no unused TUI imports");
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
        const named = stmt.importClause.namedBindings;
        if (!named || !ts.isNamedImports(named)) continue;
        const keep = named.elements.filter((el) => !names.has(el.name.text));
        if (keep.length === named.elements.length) continue;
        const start = source.lastIndexOf("\n", stmt.getStart(sf) - 1) + 1;
        let end = stmt.getEnd();
        if (source[end] === "\n") end += 1;
        if (keep.length === 0) {
            replacements.push({ start, end, text: "" });
            continue;
        }
        const spec = stmt.moduleSpecifier.getText(sf);
        const typeOnly = stmt.importClause.isTypeOnly;
        const parts = keep.map((el) => {
            const prefix = el.isTypeOnly ? "type " : "";
            if (el.propertyName) return `${prefix}${el.propertyName.text} as ${el.name.text}`;
            return `${prefix}${el.name.text}`;
        });
        const keyword = typeOnly ? "import type" : "import";
        replacements.push({
            start,
            end,
            text: `${keyword} { ${parts.join(", ")} } from ${spec};\n`,
        });
    }
    fs.writeFileSync(file, apply(source, replacements));
    console.log(`${file}: removed ${[...names].join(", ")}`);
}
