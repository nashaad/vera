// @ts-nocheck
/**
 * Peel AgentRegistry preamble and trailing helpers into siblings.
 * The class stays in agent-registry.ts. No method bodies move.
 */
const fs = require("node:fs");
const ts = require("/Users/nash/Projects/vera/node_modules/typescript/lib/typescript.js");

const SRC = "src/host/agent-registry.ts";
const SUPPORT = "src/host/agent-registry/support.ts";
const HELPERS = "src/host/agent-registry/helpers.ts";

function fail(m) {
    console.error(m);
    process.exit(1);
}

function namesOf(stmt) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) return [stmt.name.text];
    if (
        ts.isTypeAliasDeclaration(stmt)
        || ts.isInterfaceDeclaration(stmt)
        || ts.isEnumDeclaration(stmt)
        || ts.isClassDeclaration(stmt)
    ) {
        return stmt.name ? [stmt.name.text] : [];
    }
    if (ts.isVariableStatement(stmt)) {
        return stmt.declarationList.declarations
            .filter((d) => ts.isIdentifier(d.name))
            .map((d) => d.name.text);
    }
    return [];
}

function ensureExport(text) {
    if (/^export\s/.test(text) || (text.startsWith("/**") && /\nexport\s/.test(text))) {
        return text;
    }
    if (text.startsWith("/**") || text.startsWith("//") || text.startsWith("/*")) {
        const match = text.match(/^((?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*)/);
        const prefix = match ? match[1] : "";
        const rest = text.slice(prefix.length);
        if (/^export\s/.test(rest)) return text;
        return `${prefix}export ${rest}`;
    }
    return `export ${text}`;
}

const source = fs.readFileSync(SRC, "utf8");
const sf = ts.createSourceFile(SRC, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);

let importEnd = 0;
const support = [];
const helpers = [];
let classStmt = null;
for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
        importEnd = stmt.getEnd();
        continue;
    }
    if (ts.isClassDeclaration(stmt) && stmt.name?.text === "AgentRegistry") {
        classStmt = stmt;
        continue;
    }
    const names = namesOf(stmt);
    if (names.length === 0) fail(`unnamed at ${stmt.getStart(sf)}`);
    const start = stmt.getFullStart();
    const text = source.slice(start, stmt.getEnd()).replace(/^\n+/, "");
    const piece = { names, text: ensureExport(text), stmt };
    if (classStmt === null) support.push(piece);
    else helpers.push(piece);
}
if (!classStmt) fail("AgentRegistry class not found");
if (source[importEnd] === "\n") importEnd += 1;
const importBlock = source.slice(0, importEnd).trimEnd();
const classText = source.slice(classStmt.getFullStart(), classStmt.getEnd()).replace(/^\n+/, "");

function rewriteSpec(spec) {
    if (!spec.startsWith(".")) return spec;
    // support/helpers live next to agent-registry.ts, so specs stay the same
    return spec;
}

fs.writeFileSync(
    SUPPORT,
    `${importBlock}\n\n${support.map((p) => p.text).join("\n\n")}\n`,
);
fs.writeFileSync(
    HELPERS,
    `${importBlock}\n\nimport type { AgentRegistryOptions } from "./agent-registry-support.ts";\n\n${
        helpers.map((p) => p.text).join("\n\n")
    }\n`,
);

const supportNames = support.flatMap((p) => p.names);
const helperNames = helpers.flatMap((p) => p.names);
const supportImport = supportNames.length
    ? `import {\n    ${supportNames.join(",\n    ")},\n} from "./agent-registry-support.ts";\n`
    : "";
const helperImport = helperNames.length
    ? `import {\n    ${helperNames.join(",\n    ")},\n} from "./agent-registry-helpers.ts";\n`
    : "";

fs.writeFileSync(
    SRC,
    `${importBlock}\n\n${supportImport}\n${helperImport}\n${classText}\n\nexport {\n    ${
        [...supportNames, ...helperNames].join(",\n    ")
    },\n};\nexport { AgentRegistry };\n`,
);
console.log(`support ${support.length} decls -> ${SUPPORT}`);
console.log(`helpers ${helpers.length} decls -> ${HELPERS}`);
console.log(`class remains in ${SRC}`);
