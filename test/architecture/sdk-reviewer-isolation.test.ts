import { expect, test } from "bun:test";

const ROOT = new URL("../../", import.meta.url);

test("the SDK reviewer remains a direct CLI-only example", async () => {
    const workflow = await source("examples/sdk-reviewer/review.ts");
    const executable = await source("examples/sdk-reviewer/main.ts");
    const hostRuntime = await source("src/host/runtime.ts");
    const cliMain = await source("clients/cli/main.ts");
    const cliHelp = await source("clients/cli/help.ts");

    expect(workflow).toContain('from "../../index.ts"');
    expect(workflow).toContain("Vera.run");
    expect(workflow).not.toContain("Vera.create");
    expect(executable).toContain("runAdversarialWorkflow");
    expect(hostRuntime).not.toContain("adversarial-review");
    expect(hostRuntime).not.toContain("bundledHostExtensionConfigs");
    expect(cliMain).not.toContain("runAdversarialCli");
    expect(cliHelp).not.toContain("vera adversarial");
});

async function source(path: string): Promise<string> {
    return await Bun.file(new URL(path, ROOT)).text();
}
