import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

export const RELEASE_EXECUTABLE_NAME = "vera-bin";

export async function bundleRelease(releaseRoot: string, sourceRoot: string, entrypoint = join(sourceRoot, "scripts", "release-role-entry.ts")): Promise<void> {
    const tuiPackage = join(sourceRoot, "node_modules", "@opentui", "core");
    const transpiler = new Bun.Transpiler({ loader: "js" });
    const tuiExports = {
        "index.js": transpiler.scan(readFileSync(join(tuiPackage, "index.js"), "utf8")).exports,
        "testing.js": transpiler.scan(readFileSync(join(tuiPackage, "testing.js"), "utf8")).exports,
    };
    const result = await Bun.build({
        entrypoints: [entrypoint],
        root: sourceRoot,
        target: "bun",
        splitting: true,
        minify: { identifiers: true, syntax: false, whitespace: false },
        compile: { outfile: join(releaseRoot, RELEASE_EXECUTABLE_NAME) },
        external: ["@img/sharp-*/sharp.node"],
        plugins: [{
            name: "opentui-release-path",
            setup(builder) {
                builder.onResolve({ filter: /^@opentui\/core(?:\/testing)?$/ }, (args) => ({
                    path: args.path.endsWith("/testing") ? "testing.js" : "index.js",
                    namespace: "release-opentui",
                }));
                builder.onLoad({ filter: /.*/, namespace: "release-opentui" }, (args) => ({
                    contents: `const core = await import(require("node:url").pathToFileURL(require("node:path").join(require("node:path").dirname(process.execPath), "node_modules", "@opentui", "core", ${JSON.stringify(args.path)})).href);\n`
                        + tuiExports[args.path as keyof typeof tuiExports].map((name) => `export const ${name} = core.${name};`).join("\n"),
                    loader: "js",
                }));
            },
        }, {
            name: "sharp-native-paths",
            setup(builder) {
                builder.onLoad({ filter: /node_modules\/sharp\/dist\/.*\.mjs$/ }, (args) => {
                    const source = readFileSync(args.path, "utf8");
                    if (!source.includes("createRequire(import.meta.url)")) return;
                    const location = `__veraPathToFileURL(__veraJoin(__veraDirname(process.execPath), "node_modules", "sharp", "dist", ${JSON.stringify(basename(args.path))})).href`;
                    const imports = 'import { pathToFileURL as __veraPathToFileURL } from "node:url"; import { join as __veraJoin, dirname as __veraDirname } from "node:path"; import { readFileSync as __veraReadFile } from "node:fs";\n';
                    const helper = 'function __veraSharpNative(name) { const root = __veraJoin(__veraDirname(process.execPath), "node_modules", name); const pkg = JSON.parse(__veraReadFile(__veraJoin(root, "package.json"), "utf8")); return __veraJoin(root, pkg.exports["./sharp.node"]); }\n';
                    const transformed = source.replaceAll("createRequire(import.meta.url)", `createRequire(${location})`)
                        .replace(/require\(["'](@img\/sharp-[^/"']+)\/sharp\.node["']\)/g, (_match, name: string) => `require(__veraSharpNative(${JSON.stringify(name)}))`);
                    return { contents: imports + helper + transformed, loader: "js" };
                });
            },
        }, {
            name: "trash-helper-paths",
            setup(builder) {
                builder.onLoad({ filter: /node_modules\/trash\/lib\/(macos|windows)\.js$/ }, (args) => {
                    const source = readFileSync(args.path, "utf8");
                    return {
                        contents: source.replace(
                            /new URL\('(macos-trash|windows-trash\.exe)', import\.meta\.url\)/,
                            "require('node:url').pathToFileURL(require('node:path').join(require('node:path').dirname(process.execPath), 'node_modules', 'trash', 'lib', '$1'))",
                        ),
                        loader: "js",
                    };
                });
            },
        }],
    });
    if (!result.success) {
        throw new Error(`Release compilation failed: ${result.logs.map(String).join("; ")}`);
    }
}
