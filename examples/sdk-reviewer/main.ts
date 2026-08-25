import {
    runAdversarialCli,
    type AdversarialCliDependencies,
} from "./cli.ts";

export async function runAdversarialWorkflow(
    args: readonly string[],
    dependencies: AdversarialCliDependencies,
): Promise<number> {
    return await runAdversarialCli(
        ["adversarial", ...args],
        dependencies,
    ) ?? 2;
}

if (import.meta.main) {
    process.exitCode = await runAdversarialWorkflow(
        process.argv.slice(2),
        {
            stdout: process.stdout,
            stderr: process.stderr,
            workspace: process.cwd(),
        },
    );
}
