import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
    BASH_CAPTURE_LIMIT_BYTES,
    captureBounded,
} from "../tools/bounded-capture.ts";
import type { RegisteredTool, ToolOutput } from "../tools/types.ts";
import { findSkill, loadSkillCatalog } from "./catalog.ts";
import { invocationRefusal } from "./invocation-gate.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

export const skillScriptTool: RegisteredTool = {
    invocation: "top_level",
    definition: {
        name: "skill_script",
        description: "Run an executable script explicitly referenced by a loaded skill. Uses argv without a shell, the workspace as cwd, a bounded environment and output, and a timeout.",
        inputSchema: {
            type: "object",
            properties: {
                skill: { type: "string" },
                script: { type: "string" },
                args: {
                    type: "array",
                    items: { type: "string" },
                },
                timeout_ms: {
                    type: "integer",
                    minimum: 1,
                    maximum: MAX_TIMEOUT_MS,
                },
            },
            required: ["skill", "script"],
            additionalProperties: false,
        },
    },
    async execute(input, context, signal): Promise<ToolOutput> {
        if (context.invocation !== "top_level") {
            return {
                kind: "output",
                output:
                    "The skill_script tool is available only to top-level sessions.",
                isError: true,
            };
        }
        const skillName = requiredString(input.skill, "skill");
        const script = requiredString(input.script, "script");
        const args = stringArray(input.args);
        const timeoutMs = timeout(input.timeout_ms);
        const catalog = await loadSkillCatalog({
            projectRoot: context.instructionRoot,
        });
        const skill = findSkill(catalog, skillName);
        // A skill the worn agent's list leaves out is refused the same way a
        // skill that does not exist is. Naming it differently would tell the
        // model what it cannot have, which is the catalog's job, not a
        // refusal's.
        if (
            skill === undefined
            || (context.allowedSkills !== undefined
                && !context.allowedSkills.includes(skillName))
        ) {
            throw new Error(`Unknown skill: ${skillName}`);
        }
        const refusal = invocationRefusal(
            skill.metadata,
            context.isSubagent,
            context.userInvokedSkill,
        );
        if (refusal !== undefined) {
            throw new Error(refusal);
        }
        if (!isDeclaredScript(script, skill.instructions)) {
            throw new Error(
                `Skill ${skillName} does not reference script ${script}`,
            );
        }

        const scriptsDirectory = await realpath(resolve(skill.directory, "scripts"));
        const scriptPath = await realpath(resolve(skill.directory, script));
        if (!isWithin(scriptsDirectory, scriptPath)) {
            throw new Error(`Skill script leaves its scripts directory: ${script}`);
        }
        const details = await stat(scriptPath);
        if (!details.isFile()) {
            throw new Error(`Skill script is not a regular file: ${script}`);
        }
        if (process.platform !== "win32" && (details.mode & 0o111) === 0) {
            throw new Error(`Skill script is not executable: ${script}`);
        }

        return runSkillScript({
            scriptPath,
            args,
            workspace: context.workspace,
            skillDirectory: skill.directory,
            timeoutMs,
            signal,
        });
    },
};

interface RunSkillScriptOptions {
    readonly scriptPath: string;
    readonly args: readonly string[];
    readonly workspace: string;
    readonly skillDirectory: string;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
}

export async function runSkillScript(
    options: RunSkillScriptOptions,
): Promise<ToolOutput> {
    options.signal.throwIfAborted();
    const subprocess = Bun.spawn([options.scriptPath, ...options.args], {
        cwd: options.workspace,
        stdout: "pipe",
        stderr: "pipe",
        detached: process.platform !== "win32",
        env: skillEnvironment(options.workspace, options.skillDirectory),
    });
    let timedOut = false;
    const stop = (): void => killProcessTree(subprocess.pid);
    options.signal.addEventListener("abort", stop, { once: true });
    if (options.signal.aborted) {
        stop();
    }
    const timer = setTimeout(() => {
        timedOut = true;
        stop();
    }, options.timeoutMs);

    try {
        const [stdout, stderr, exitCode] = await Promise.all([
            captureBounded(
                subprocess.stdout,
                BASH_CAPTURE_LIMIT_BYTES / 2,
                "stdout",
            ),
            captureBounded(
                subprocess.stderr,
                BASH_CAPTURE_LIMIT_BYTES / 2,
                "stderr",
            ),
            subprocess.exited,
        ]);
        if (timedOut) {
            return {
                kind: "output",
                output: `Skill script timed out after ${options.timeoutMs} ms`,
                isError: true,
            };
        }
        options.signal.throwIfAborted();
        const output = [stdout.text, stderr.text]
            .filter((text) => text.length > 0)
            .join("\n")
            .trim();
        return {
            kind: "output",
            output: exitCode === 0
                ? output || "(no output)"
                : output.length === 0
                    ? `Skill script exited with code ${exitCode}`
                    : `${output}\n\nSkill script exited with code ${exitCode}`,
            isError: exitCode !== 0,
        };
    } finally {
        clearTimeout(timer);
        options.signal.removeEventListener("abort", stop);
    }
}

export function isDeclaredScript(
    script: string,
    instructions: string,
): boolean {
    if (
        isAbsolute(script)
        || !/^scripts\/[A-Za-z0-9._/-]+$/.test(script)
        || script.split("/").includes("..")
    ) {
        return false;
    }
    const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
        `(^|[\\s\\x60'\"(])(?:\\./)?${escaped}(?=$|[\\s\\x60'\"),])`,
    )
        .test(instructions);
}

function requiredString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`skill_script requires a non-empty ${field}`);
    }
    return value.trim();
}

function stringArray(value: unknown): readonly string[] {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new Error("skill_script args must be an array of strings");
    }
    return value as readonly string[];
}

function timeout(value: unknown): number {
    if (value === undefined) {
        return DEFAULT_TIMEOUT_MS;
    }
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_TIMEOUT_MS) {
        throw new Error(`skill_script timeout_ms must be between 1 and ${MAX_TIMEOUT_MS}`);
    }
    return value as number;
}

function skillEnvironment(
    workspace: string,
    skillDirectory: string,
): Record<string, string> {
    const env: Record<string, string> = {
        VERA_WORKSPACE: workspace,
        VERA_SKILL_DIR: skillDirectory,
    };
    for (const name of [
        "HOME",
        "LANG",
        "LC_ALL",
        "PATH",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "TMPDIR",
    ]) {
        const value = process.env[name];
        if (value !== undefined) {
            env[name] = value;
        }
    }
    return env;
}

function killProcessTree(pid: number): void {
    try {
        if (process.platform === "win32") {
            Bun.spawnSync(["taskkill", "/pid", String(pid), "/t", "/f"], {
                stdout: "ignore",
                stderr: "ignore",
            });
        } else {
            process.kill(-pid, "SIGKILL");
        }
    } catch {
        // The process may have exited between the timer or abort and the kill.
    }
}

function isWithin(directory: string, candidate: string): boolean {
    const path = relative(directory, candidate);
    return path === ""
        || (path !== ".."
            && !path.startsWith(`..${sep}`)
            && !isAbsolute(path));
}
