/** Read a prompt from a file and run it through Vera. Avoids the argv limit. */

import { readFileSync } from "node:fs";

import { Vera } from "../../src/sdk/agent.ts";

const promptPath = process.argv[2];
const mode = process.argv[3];
const modelRef = process.argv[4];
const sessionPath = process.argv[5];
if (!promptPath || !mode || !modelRef || !sessionPath) {
    process.stderr.write("usage: ask.ts <prompt-file> <bare|prompt_only> <provider/model> <session>\n");
    process.exit(2);
}
const slash = modelRef.indexOf("/");
const provider = modelRef.slice(0, slash);
const model = modelRef.slice(slash + 1);
const result = await Vera.run({
    prompt: readFileSync(promptPath, "utf8"),
    workspace: process.cwd(),
    provider,
    model,
    ...(mode === "prompt_only" ? { tools: [] } : { tools: [] }),
    sessionPath,
});
if (result.transcript) process.stdout.write(result.transcript);
if (result.outcome !== "completed") {
    process.stderr.write(result.error?.message ?? result.outcome);
    process.exit(1);
}
