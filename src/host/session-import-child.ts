import { parseSourceFile } from "./session-import-source.ts";

const path = process.argv[2];
if (path === undefined) {
    process.stderr.write("usage: session-import-child <path>\n");
    process.exitCode = 2;
} else {
    process.stdout.write(JSON.stringify(await parseSourceFile(path)));
}
