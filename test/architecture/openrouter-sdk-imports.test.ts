import { expect, test } from "bun:test";
import ts from "typescript";

test("OpenRouter SDK runtime imports are confined to the loader and preferences schema", async () => {
    const violations: string[] = [];
    const paths = ["index.ts"];
    for await (const path of new Bun.Glob("{src,clients,extensions}/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}").scan()) {
        paths.push(path);
    }
    for (const path of paths) {
        const source = ts.createSourceFile(path, await Bun.file(path).text(), ts.ScriptTarget.Latest, true);
        const visit = (node: ts.Node): void => {
            let specifier: string | undefined;
            let runtime = true;
            if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
                if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
                    specifier = node.moduleSpecifier.text;
                    runtime = ts.isImportDeclaration(node)
                        ? node.importClause === undefined || !node.importClause.isTypeOnly
                        : !node.isTypeOnly;
                }
            } else if (ts.isCallExpression(node) && node.arguments.length > 0
                && (node.expression.kind === ts.SyntaxKind.ImportKeyword
                    || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
                const arg = node.arguments[0];
                if (arg && ts.isStringLiteralLike(arg)) specifier = arg.text;
            }
            if (runtime && specifier?.startsWith("@openrouter/sdk")) {
                const allowed = path === "src/providers/openrouter-sdk.ts"
                    && (specifier === "@openrouter/sdk" || specifier === "@openrouter/sdk/models/errors")
                    && ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
                const schema = path === "src/providers/request-options.ts"
                    && specifier === "@openrouter/sdk/models/providerpreferences";
                if (!allowed && !schema) violations.push(`${path}: ${specifier}`);
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    expect(violations).toEqual([]);
});
