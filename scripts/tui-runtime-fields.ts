// @ts-nocheck
const ts = require("/Users/nash/Projects/vera/node_modules/typescript/lib/typescript.js");
const prog = ts.createProgram(["clients/tui/main.ts"], {
    target: 99, module: 200, strict: true, skipLibCheck: true,
    moduleResolution: 100, allowImportingTsExtensions: true, noEmit: true,
});
const checker = prog.getTypeChecker();
const sf = prog.getSourceFile("clients/tui/main.ts");
if (!sf) throw new Error("missing clients/tui/main.ts");
const startTui = sf.statements.find(
    (s) => ts.isFunctionDeclaration(s) && s.name?.text === "startTui",
);
if (!startTui?.body) throw new Error("missing startTui");
for (const s of startTui.body.statements) {
    if (!ts.isVariableStatement(s)) continue;
    for (const d of s.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) {
            console.error(`# skip non-identifier: ${d.name.getText(sf)}`);
            continue;
        }
        const type = d.type
            ? d.type.getText(sf)
            : checker.typeToString(
                checker.getTypeAtLocation(d.name),
                d,
                ts.TypeFormatFlags.NoTruncation,
            );
        console.log(`    ${d.name.text}: ${type};`);
    }
}
