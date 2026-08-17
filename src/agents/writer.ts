/**
 * The one thing a wire command may write into an agent file: its default pair.
 *
 * Deliberately narrow. Everything else about an agent is edited with your
 * editor, so the file stays the definition rather than a cache of one. The
 * write is temp-and-rename, so a crash leaves the old file rather than half a
 * new one.
 */

import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface AgentDefaultPair {
    readonly name: string;
    readonly effort?: string;
}

/**
 * Rewrite (or clear) `default_pair` in an agent file, leaving every other
 * line of frontmatter and the whole body byte-identical.
 *
 * Rewriting the file from a parsed object would reformat somebody's YAML and
 * drop their comments, so the key is edited in place as text.
 */
export async function writeAgentDefaultPair(
    path: string,
    pair: AgentDefaultPair | null,
): Promise<void> {
    const source = await readFile(path, "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(source);
    const line = pair === null ? undefined : renderDefaultPair(pair);
    let next: string;
    if (match === null) {
        // No frontmatter yet: an agent that is instructions alone. Clearing a
        // key it does not have is a no-op rather than a reason to add a block.
        if (line === undefined) return;
        next = `---\n${line}\n---\n${source}`;
    } else {
        const body = match[1] ?? "";
        const rewritten = replaceKey(body, "default_pair", line);
        next = `---\n${rewritten}\n---${match[2] ?? "\n"}${
            source.slice(match[0].length)
        }`;
    }
    const temporary = join(dirname(path), `.${randomUUID()}.agent.tmp`);
    await writeFile(temporary, next, { mode: 0o600 });
    await rename(temporary, path);
}

function renderDefaultPair(pair: AgentDefaultPair): string {
    const effort = pair.effort === undefined
        ? ""
        : `, effort: ${JSON.stringify(pair.effort)}`;
    return `default_pair: { name: ${JSON.stringify(pair.name)}${effort} }`;
}

/**
 * Replace one top-level key's line (and any lines indented under it), or
 * append the key when it was not there. `undefined` removes it.
 */
function replaceKey(
    body: string,
    key: string,
    line: string | undefined,
): string {
    const lines = body.split(/\r?\n/);
    const at = lines.findIndex((text) => text.startsWith(`${key}:`));
    if (at < 0) {
        return line === undefined
            ? body
            : [...lines.filter((text, index) =>
                text.length > 0 || index !== lines.length - 1
            ), line].join("\n");
    }
    let end = at + 1;
    while (end < lines.length && /^\s+\S/.test(lines[end] ?? "")) {
        end += 1;
    }
    return [
        ...lines.slice(0, at),
        ...(line === undefined ? [] : [line]),
        ...lines.slice(end),
    ].join("\n");
}
