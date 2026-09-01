// @ts-nocheck
/** Strip `private` from AgentRegistry members so sibling modules can take `this`. */
const fs = require("node:fs");
const ts = require("/Users/nash/Projects/vera/node_modules/typescript/lib/typescript.js");

const SRC = "src/host/agent-registry.ts";
const source = fs.readFileSync(SRC, "utf8");
const sf = ts.createSourceFile(SRC, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);

let cls;
function find(n) {
    if (ts.isClassDeclaration(n) && n.name?.text === "AgentRegistry") cls = n;
    ts.forEachChild(n, find);
}
find(sf);
if (!cls) {
    console.error("class not found");
    process.exit(1);
}

const replacements = [];
function stripPrivate(node) {
    const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    const priv = mods?.find((m) => m.kind === ts.SyntaxKind.PrivateKeyword);
    if (priv) {
        let start = priv.getStart(sf);
        let end = priv.getEnd();
        while (source[end] === " ") end += 1;
        replacements.push({ start, end, text: "" });
    }
    if (ts.isParameter(node) && node.parent && ts.isConstructorDeclaration(node.parent)) {
        const pmods = ts.getModifiers(node);
        const ppriv = pmods?.find((m) => m.kind === ts.SyntaxKind.PrivateKeyword);
        if (ppriv) {
            let start = ppriv.getStart(sf);
            let end = ppriv.getEnd();
            while (source[end] === " ") end += 1;
            replacements.push({ start, end, text: "" });
        }
    }
}

for (const m of cls.members) {
    stripPrivate(m);
    if (ts.isConstructorDeclaration(m)) {
        for (const p of m.parameters) stripPrivate(p);
    }
}

replacements.sort((a, b) => b.start - a.start);
let out = source;
for (const r of replacements) out = out.slice(0, r.start) + r.text + out.slice(r.end);
fs.writeFileSync(SRC, out);
console.log(`stripped ${replacements.length} private modifiers`);
