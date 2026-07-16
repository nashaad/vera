#!/usr/bin/env bun

import { stderr, stdout } from "node:process";

import {
    createInstanceDirectory,
    type InstanceDirectory,
    type InstanceRecord,
} from "./instances/directory.ts";
import { runNdjsonProcess } from "./ndjson.ts";

interface CliOutput {
    write(text: string): unknown;
}

export interface CliDependencies {
    readonly instances?: InstanceDirectory;
    readonly stdout?: CliOutput;
    readonly stderr?: CliOutput;
    readonly runRpc?: () => Promise<void>;
}

export async function runCli(
    args: readonly string[],
    dependencies: CliDependencies = {},
): Promise<number> {
    const output = dependencies.stdout ?? stdout;
    const errorOutput = dependencies.stderr ?? stderr;

    if (args.length === 1 && args[0] === "ls") {
        const instances = dependencies.instances ?? createInstanceDirectory();
        output.write(renderInstanceList(instances.list()));
        return 0;
    }

    if (args.length === 1 && args[0] === "rpc") {
        await (dependencies.runRpc ?? runNdjsonProcess)();
        return 0;
    }

    errorOutput.write("Usage: vera <ls|rpc>\n");
    return 1;
}

export function renderInstanceList(records: readonly InstanceRecord[]): string {
    if (records.length === 0) {
        return "No live Vera instances.\n";
    }

    const rows = records.map((record) => [
        String(record.pid),
        record.client,
        record.started_at,
        record.workspace_path,
        record.instance_id,
    ]);
    const headings = ["PID", "CLIENT", "STARTED", "WORKSPACE", "INSTANCE"];
    const widths = headings.map((heading, index) =>
        Math.max(heading.length, ...rows.map((row) => row[index]?.length ?? 0))
    );

    return [headings, ...rows]
        .map((row) => row
            .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
            .join("  ")
            .trimEnd())
        .join("\n") + "\n";
}

if (import.meta.main) {
    process.exitCode = await runCli(process.argv.slice(2));
}
