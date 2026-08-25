import { expect, test } from "bun:test";

const ROOT = new URL("../../", import.meta.url);

test("the adversarial workflow is application code and adapters only expose it", async () => {
    const workflow = await source("workflows/adversarial-review/review.ts");
    const executable = await source("workflows/adversarial-review/main.ts");
    const extension = await source("extensions/adversarial/extension.ts");
    const cli = await source("clients/cli/adversarial.ts");

    expect(workflow).toContain('from "../../index.ts"');
    expect(workflow).not.toContain("extensions/adversarial");
    expect(executable).toContain("runAdversarialWorkflow");
    expect(extension).toContain(
        'from "../../workflows/adversarial-review/review.ts"',
    );
    expect(cli).toContain(
        'from "../../workflows/adversarial-review/cli.ts"',
    );
});

async function source(path: string): Promise<string> {
    return await Bun.file(new URL(path, ROOT)).text();
}
