import { parseArgs } from "node:util";

import { buildCatalog, CATALOG_BASE_URL, OUTPUT_DIR, SOURCE_DIR } from "./build-catalog.ts";
import { CatalogBuildError } from "./build-error.ts";

// `--out <folder>` writes somewhere other than catalog/published; `--base-url <url>` lists the packages at another
// address, for a catalog served from a local server. Changing the address needs a folder of its own.
const { values } = parseArgs({ options: { out: { type: "string" }, "base-url": { type: "string" } }, strict: true });
if (values["base-url"] !== undefined && values.out === undefined) {
    console.error("--base-url needs --out, so the committed catalog keeps its address");
    process.exit(2);
}

try {
    const written = buildCatalog({
        sourceDir: SOURCE_DIR,
        outDir: values.out ?? OUTPUT_DIR,
        baseUrl: values["base-url"] ?? CATALOG_BASE_URL,
    });
    for (const name of written) console.log(name);
} catch (error) {
    if (!(error instanceof CatalogBuildError)) throw error;
    console.error(error.message);
    process.exit(1);
}
