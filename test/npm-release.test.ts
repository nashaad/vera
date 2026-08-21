import { createHash } from "node:crypto";
import {
    chmodSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expect, test } from "bun:test";

const checker = resolve(import.meta.dir, "..", "scripts", "check-npm-release.ts");

interface RegistryResponse {
    readonly code?: number;
    readonly value?: unknown;
    readonly stderr?: string;
}

interface WorkflowInput {
    readonly default?: string;
    readonly description?: string;
    readonly options?: readonly string[];
}

interface WorkflowStep {
    readonly name?: string;
    readonly run?: string;
}

interface WorkflowJob {
    readonly if?: string;
    readonly needs?: string | readonly string[];
    readonly steps?: readonly WorkflowStep[];
}

interface ReleaseWorkflow {
    readonly on: {
        readonly workflow_dispatch: {
            readonly inputs: Record<string, WorkflowInput>;
        };
    };
    readonly jobs: Record<string, WorkflowJob>;
}

interface IntentGuardResult {
    readonly exitCode: number;
    readonly stderr: string;
    readonly summary: string;
}

const releaseWorkflowPath = resolve(
    import.meta.dir,
    "..",
    ".github",
    "workflows",
    "release.yml",
);
const releaseWorkflow = Bun.YAML.parse(
    readFileSync(releaseWorkflowPath, "utf8"),
) as ReleaseWorkflow;

function runIntentGuard(mode: string, confirmation: string): IntentGuardResult {
    const root = mkdtempSync(join(tmpdir(), "vera-release-intent-test-"));
    const summaryPath = join(root, "summary.md");
    const script = releaseWorkflow.jobs["validate-request"]?.steps?.[0]?.run;
    if (!script) throw new Error("release intent guard is missing");
    const result = Bun.spawnSync(["sh", "-c", script], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
            ...process.env,
            GITHUB_STEP_SUMMARY: summaryPath,
            RELEASE_MODE: mode,
            PUBLISH_CONFIRMATION: confirmation,
        },
    });
    const summary = Bun.file(summaryPath).size > 0
        ? readFileSync(summaryPath, "utf8")
        : "";
    rmSync(root, { recursive: true, force: true });
    return {
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
        summary,
    };
}

function runChecker(
    mode: "prepare" | "verify",
    version: string,
    responses: Record<string, RegistryResponse>,
    requireProvenance = false,
): ReturnType<typeof Bun.spawnSync> {
    const root = mkdtempSync(join(tmpdir(), "vera-npm-release-test-"));
    const archive = join(root, "package.tgz");
    const fakeNpm = join(root, "npm");
    writeFileSync(archive, "exact package bytes");
    writeFileSync(fakeNpm, `#!/usr/bin/env bun
const responses = JSON.parse(process.env.FAKE_NPM_RESPONSES ?? "{}");
const key = \`${"${Bun.argv[3]}|${Bun.argv[4]}"}\`;
const response = responses[key];
if (!response) {
    console.error("npm error code E404");
    process.exit(1);
}
if (response.stderr) console.error(response.stderr);
if (response.value !== undefined) console.log(JSON.stringify(response.value));
process.exit(response.code ?? 0);
`);
    chmodSync(fakeNpm, 0o755);
    const args = ["bun", checker, mode, archive, version];
    if (requireProvenance) args.push("--require-provenance");
    const result = Bun.spawnSync(args, {
        stdout: "pipe",
        stderr: "pipe",
        env: {
            ...process.env,
            PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
            FAKE_NPM_RESPONSES: JSON.stringify(responses),
        },
    });
    rmSync(root, { recursive: true, force: true });
    return result;
}

function integrity(): string {
    return `sha512-${createHash("sha512")
        .update("exact package bytes")
        .digest("base64")}`;
}

test("release workflow defaults to a test-only rehearsal", () => {
    const inputs = releaseWorkflow.on.workflow_dispatch.inputs;
    expect(inputs.release_mode?.default).toBe("test-only");
    expect(inputs.release_mode?.options).toEqual(["test-only", "publish-public"]);
    expect(inputs.release_mode?.description).toContain("runtime TypeScript source");
    expect(inputs.publish_confirmation?.description).toContain(
        "PUBLISH @nashaad/vera SOURCE PUBLICLY",
    );
    expect(releaseWorkflow.jobs["build-package"]?.needs).toBe("validate-request");
    expect(releaseWorkflow.jobs.publish?.if).toBe(
        "inputs.release_mode == 'publish-public'",
    );
    const releaseTests = releaseWorkflow.jobs["build-package"]?.steps
        ?.find((step) => step.name === "Run package, installer, and release safety tests")
        ?.run;
    expect(releaseTests).toContain("test/npm-release.test.ts");
});

test("all npm publish commands remain in the explicitly gated step", () => {
    const publishSteps = Object.entries(releaseWorkflow.jobs).flatMap(
        ([jobName, job]) => (job.steps ?? [])
            .filter((step) => step.run?.includes("npm publish"))
            .map((step) => ({
                jobName,
                stepName: step.name,
                commandCount: step.run?.match(/npm publish/g)?.length ?? 0,
            })),
    );
    expect(publishSteps).toEqual([{
        jobName: "publish",
        stepName: "Publish verified npm package",
        commandCount: 2,
    }]);
});

test("test-only release intent does not authorize an upload", () => {
    const result = runIntentGuard("test-only", "");
    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("It will not upload anything to npm.");
});

test("public release intent requires the exact source-publication phrase", () => {
    const rejected = runIntentGuard("publish-public", "publish");
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr).toContain("requires the exact confirmation phrase");

    const accepted = runIntentGuard(
        "publish-public",
        "PUBLISH @nashaad/vera SOURCE PUBLICLY",
    );
    expect(accepted.exitCode).toBe(0);
    expect(accepted.summary).toContain("runtime TypeScript source");
    expect(accepted.summary).toContain("GitHub repository is private");
});

test("new npm version may advance latest", () => {
    const result = runChecker("prepare", "1.2.3", {
        "@nashaad/vera|dist-tags.latest": { value: "1.2.2" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout?.toString()).toContain("publish=true");
});

test("identical published npm version is an idempotent rerun", () => {
    const result = runChecker("prepare", "1.2.3", {
        "@nashaad/vera@1.2.3|dist.integrity": { value: integrity() },
        "@nashaad/vera|dist-tags.latest": { value: "1.2.3" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout?.toString()).toContain("publish=false");
});

test("npm release refuses different bytes for an existing version", () => {
    const result = runChecker("prepare", "1.2.3", {
        "@nashaad/vera@1.2.3|dist.integrity": { value: "sha512-different" },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr?.toString()).toContain("registry integrity differs");
});

test("npm release refuses to move latest backward", () => {
    const result = runChecker("prepare", "1.2.3", {
        "@nashaad/vera|dist-tags.latest": { value: "1.2.4" },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr?.toString()).toContain("refusing to move npm latest backward");
});

test("npm release verifies bytes, latest, and provenance", () => {
    const result = runChecker("verify", "1.2.3", {
        "@nashaad/vera@1.2.3|dist.integrity": { value: integrity() },
        "@nashaad/vera|dist-tags.latest": { value: "1.2.3" },
        "@nashaad/vera@1.2.3|dist.attestations": {
            value: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } },
        },
    }, true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout?.toString()).toContain('"published":true');
});
