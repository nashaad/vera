import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
    MEMORY_INDEX_FILENAME,
    MEMORY_INDEX_MAX_BYTES,
    MEMORY_INDEX_WARN_BYTES,
    MEMORY_TOPIC_MAX_BYTES,
    projectMemoryDir,
    userMemoryDir,
} from "../engine/memory-paths.ts";
import type { ToolRuntime } from "./runtime.ts";
import type { RegisteredTool, ToolOutput } from "./types.ts";

const TOPIC_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

const BACKUP_SUFFIX = ".bak";

type MemoryScope = "user" | "project";

export const memoryWriteTool: RegisteredTool = {
    permissionOperation: "memory.write",
    definition: {
        name: "memory_write",
        description: [
            "Record a durable fact in Vera's memory. `user` scope is about the",
            "person and follows them everywhere; `project` scope is about this",
            "codebase. Writes are whole-file: send the complete new body, which",
            "lets you correct a stale fact in place. Every topic file needs an",
            `index line in ${MEMORY_INDEX_FILENAME}, so pass title and hook;`,
            "the index is always in context and topic bodies are only read when",
            "a hook earns the read.",
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                scope: {
                    type: "string",
                    enum: ["user", "project"],
                },
                file: {
                    type: "string",
                    description:
                        `Topic filename such as "build-commands.md", or `
                        + `"${MEMORY_INDEX_FILENAME}" to rewrite the index.`,
                },
                content: {
                    type: "string",
                    description: "The complete new body of the file.",
                },
                title: {
                    type: "string",
                    description:
                        "Link text for the index line. Required for a topic file.",
                },
                hook: {
                    type: "string",
                    description:
                        "One line saying what the topic answers, specific enough"
                        + " to decide whether to read it. Required for a topic"
                        + " file.",
                },
            },
            required: ["scope", "file", "content"],
            additionalProperties: false,
        },
    },
    async execute(input, context) {
        const scope = readScope(input.scope);
        const file = readFilename(input.file);
        const content = readString(input.content, "content");
        const directory = scopeDirectory(scope, context);
        return context.enqueueFileMutation(() =>
            file === MEMORY_INDEX_FILENAME
                ? writeIndex(context, directory, scope, content)
                : writeTopic(context, directory, scope, file, content, input)
        );
    },
};

function scopeDirectory(scope: MemoryScope, context: ToolRuntime): string {
    return scope === "user"
        ? userMemoryDir()
        : projectMemoryDir(context.instructionRoot);
}

async function writeIndex(
    context: ToolRuntime,
    directory: string,
    scope: MemoryScope,
    content: string,
): Promise<ToolOutput> {
    const body = normalize(content);
    assertUnder(body, MEMORY_INDEX_MAX_BYTES, MEMORY_INDEX_FILENAME);
    const path = join(directory, MEMORY_INDEX_FILENAME);
    await mkdir(directory, { recursive: true });
    await backup(context, path);
    await Bun.write(path, body);
    return {
        kind: "output",
        output: summary(
            `Wrote ${scope} ${MEMORY_INDEX_FILENAME}`,
            body,
            path,
            indexWarning(body),
        ),
        isError: false,
    };
}

async function writeTopic(
    context: ToolRuntime,
    directory: string,
    scope: MemoryScope,
    file: string,
    content: string,
    input: Readonly<Record<string, unknown>>,
): Promise<ToolOutput> {
    const body = normalize(content);
    assertUnder(body, MEMORY_TOPIC_MAX_BYTES, file);
    const title = readString(input.title, "title").trim();
    const hook = readString(input.hook, "hook").trim().replace(/\s+/g, " ");
    if (title.length === 0 || hook.length === 0) {
        throw new Error("memory_write title and hook must not be blank");
    }

    const indexPath = join(directory, MEMORY_INDEX_FILENAME);
    const currentIndex = await readIfPresent(indexPath);
    const nextIndex = withIndexLine(currentIndex, file, title, hook);
    assertUnder(nextIndex, MEMORY_INDEX_MAX_BYTES, MEMORY_INDEX_FILENAME);

    const path = join(directory, file);
    await mkdir(directory, { recursive: true });
    await backup(context, path);
    await Bun.write(path, body);
    if (nextIndex !== currentIndex) {
        await backup(context, indexPath);
        await Bun.write(indexPath, nextIndex);
    }

    const indexNote = currentIndex === nextIndex
        ? "index line unchanged"
        : currentIndex.includes(`](${file})`)
            ? "index line updated"
            : "index line added";
    return {
        kind: "output",
        output: summary(
            `Wrote ${scope} memory ${file}`,
            body,
            path,
            `${indexNote}${indexWarning(nextIndex)}`,
        ),
        isError: false,
    };
}

async function backup(context: ToolRuntime, path: string): Promise<void> {
    const previous = Bun.file(path);
    if (!(await previous.exists())) {
        return;
    }
    const content = await previous.text();
    await Bun.write(`${path}${BACKUP_SUFFIX}`, content);
    await context.stashPreimage(path, content);
}

function withIndexLine(
    index: string,
    file: string,
    title: string,
    hook: string,
): string {
    const line = `- [${title}](${file}): ${hook}`;
    const target = `](${file})`;
    const lines = index === "" ? [] : index.replace(/\n$/, "").split("\n");
    const at = lines.findIndex((existing) =>
        existing.trimStart().startsWith("- [") && existing.includes(target)
    );
    if (at >= 0) {
        if (lines[at] === line) {
            return index;
        }
        lines[at] = line;
        return normalize(lines.join("\n"));
    }
    return normalize([...lines, line].join("\n"));
}

async function readIfPresent(path: string): Promise<string> {
    const file = Bun.file(path);
    return (await file.exists()) ? await file.text() : "";
}

function indexWarning(index: string): string {
    return Buffer.byteLength(index) > MEMORY_INDEX_WARN_BYTES
        ? `, ${MEMORY_INDEX_FILENAME} is past `
            + `${MEMORY_INDEX_WARN_BYTES} bytes and should be trimmed`
        : "";
}

function summary(
    headline: string,
    body: string,
    path: string,
    note: string,
): string {
    const bytes = Buffer.byteLength(body).toLocaleString();
    const suffix = note.startsWith(",") ? note : note === "" ? "" : ` (${note})`;
    return `${headline} (${bytes} bytes) at ${path}${suffix}`;
}

function normalize(content: string): string {
    const trimmed = content.replace(/\s+$/, "");
    return trimmed === "" ? "" : `${trimmed}\n`;
}

function assertUnder(content: string, limit: number, name: string): void {
    const bytes = Buffer.byteLength(content);
    if (bytes > limit) {
        throw new Error(
            `memory_write refused ${name}: ${bytes.toLocaleString()} bytes `
                + `exceeds the ${limit.toLocaleString()} byte limit. Split the `
                + "content or cut it down rather than growing the file.",
        );
    }
}

function readScope(value: unknown): MemoryScope {
    if (value !== "user" && value !== "project") {
        throw new Error(`memory_write scope must be "user" or "project"`);
    }
    return value;
}

function readFilename(value: unknown): string {
    const file = readString(value, "file");
    if (!TOPIC_FILENAME.test(file) || file.includes("..")) {
        throw new Error(
            "memory_write file must be a plain .md filename inside the scope "
                + `directory, not "${file}"`,
        );
    }
    return file;
}

function readString(value: unknown, field: string): string {
    if (typeof value !== "string") {
        throw new Error(`memory_write requires a string ${field}`);
    }
    return value;
}
