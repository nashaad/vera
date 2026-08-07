import type { RegisteredTool, ToolOutput } from "./types.ts";
import { resolveReadPath } from "./files.ts";

const DEFAULT_MAX_RESULTS = 250;
/**
 * Byte limits, both of them safety invariants rather than settings. The count
 * cap alone bounds neither memory nor context: 250 lines of minified
 * JavaScript is as unbounded as no cap at all.
 */
const MAX_LINE_BYTES = 2 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;
/**
 * How far past the window the scan will go to learn the true match count.
 * Lines beyond the window are counted and dropped, so this bounds time, not
 * memory; the search is abandoned once even counting stops being worth it.
 */
const MAX_SCANNED_LINES = 20_000;
const MAX_RESULTS_CAP = 1000;
const MAX_CONTEXT_LINES = 50;
const OUTPUT_MODES = ["files_with_matches", "content", "count"] as const;
type OutputMode = (typeof OUTPUT_MODES)[number];

const RIPGREP_NOT_FOUND_MESSAGE = "ripgrep (rg) is required for the grep "
    + "tool but was not found on PATH. Install it (e.g. `brew install "
    + "ripgrep`, `apt install ripgrep`) and try again.";

const DESCRIPTION = [
    "Search file contents with ripgrep. Read-only; does not go through a shell.",
    "Always use this tool to search file contents. NEVER invoke `grep`, `rg`,",
    "`ack`, or `find -exec grep` through the bash tool: those go through a",
    "shell, cost a permission decision, and have no result cap.",
    "Supports full regex syntax, `glob` and `type` filters, context lines,",
    "and `offset` for paging through a large result set.",
].join(" ");

export const grepTool: RegisteredTool = {
    permissionInputs: [{ field: "path", kind: "path", verb: "read" }],
    definition: {
        name: "grep",
        description: DESCRIPTION,
        inputSchema: {
            type: "object",
            properties: {
                pattern: { type: "string" },
                path: { type: "string" },
                case_insensitive: { type: "boolean" },
                fixed_strings: { type: "boolean" },
                word_regexp: { type: "boolean" },
                multiline: { type: "boolean" },
                glob: { type: "string" },
                type: { type: "string" },
                hidden: { type: "boolean" },
                before_context: { type: "integer", minimum: 0 },
                after_context: { type: "integer", minimum: 0 },
                context: { type: "integer", minimum: 0 },
                offset: { type: "integer", minimum: 0 },
                max_results: { type: "integer", minimum: 1 },
                output_mode: { type: "string", enum: [...OUTPUT_MODES] },
            },
            required: ["pattern", "path"],
            additionalProperties: false,
        },
    },
    async execute(input, context): Promise<ToolOutput> {
        const pattern = requiredString(input, "pattern");
        const requestedPath = requiredString(input, "path");
        const targetPath = await resolveReadPath(context.workspace, requestedPath);
        const outputMode = parseOutputMode(input.output_mode);
        const maxResults = parseMaxResults(input.max_results);
        const offset = parseCount(
            input.offset,
            "offset",
            0,
            Number.MAX_SAFE_INTEGER,
        );

        const args = ["rg", "--color=never", "--no-heading"];
        if (input.hidden === true) {
            args.push("--hidden");
        }
        if (input.case_insensitive === true) {
            args.push("--ignore-case");
        }
        if (input.fixed_strings === true) {
            args.push("--fixed-strings");
        }
        if (input.word_regexp === true) {
            args.push("--word-regexp");
        }
        if (input.multiline === true) {
            args.push("--multiline", "--multiline-dotall");
        }
        if (typeof input.glob === "string") {
            args.push("--glob", input.glob);
        }
        if (typeof input.type === "string") {
            args.push("--type", input.type);
        }
        if (outputMode === "files_with_matches") {
            args.push("--files-with-matches");
        } else if (outputMode === "count") {
            args.push("--count");
        } else {
            args.push("--line-number");
            // Context lines only mean anything when matched lines are shown.
            pushContextArgs(args, input);
        }
        args.push("--", pattern, targetPath);

        return runRipgrep(args, maxResults, offset);
    },
};

function pushContextArgs(
    args: string[],
    input: Readonly<Record<string, unknown>>,
): void {
    const around = parseCount(input.context, "context", 0, MAX_CONTEXT_LINES);
    if (around > 0) {
        args.push("--context", String(around));
        return;
    }
    const before = parseCount(
        input.before_context,
        "before_context",
        0,
        MAX_CONTEXT_LINES,
    );
    const after = parseCount(
        input.after_context,
        "after_context",
        0,
        MAX_CONTEXT_LINES,
    );
    if (before > 0) {
        args.push("--before-context", String(before));
    }
    if (after > 0) {
        args.push("--after-context", String(after));
    }
}

async function runRipgrep(
    args: string[],
    maxResults: number,
    offset: number,
): Promise<ToolOutput> {
    // Bun.spawn resolves argv[0] against its own cached PATH rather than the
    // `env` passed to the child, so check for the binary explicitly first.
    if (Bun.which("rg", { PATH: process.env.PATH ?? "" }) === null) {
        return { kind: "output", output: RIPGREP_NOT_FOUND_MESSAGE, isError: true };
    }

    const subprocess = spawnRipgrep(args);
    if (subprocess === null) {
        return { kind: "output", output: RIPGREP_NOT_FOUND_MESSAGE, isError: true };
    }

    const [collected, stderr, exitCode] = await Promise.all([
        collectLines(subprocess.stdout, maxResults + offset, () => {
            subprocess.kill();
        }),
        new Response(subprocess.stderr).text(),
        subprocess.exited,
    ]);

    // rg exits 1 for "no matches", which is a normal, successful result. A run
    // Vera stopped early reports whatever the kill produced, and its lines are
    // the answer, so its code is not a failure either.
    if (exitCode > 1 && !collected.stopped) {
        return {
            kind: "output",
            output: stderr.trim() || `rg exited with code ${exitCode}`,
            isError: true,
        };
    }

    return {
        kind: "output",
        output: formatResults(collected, maxResults, offset),
        isError: false,
    };
}

interface CollectedLines {
    readonly lines: readonly string[];
    /** Matches seen, which is more than were kept once the window is full. */
    readonly total: number;
    /** True when rg was still producing when Vera stopped reading. */
    readonly stopped: boolean;
    readonly longLines: number;
}

/**
 * Reads rg's output line by line, retaining only the window the caller asked
 * for and counting the rest.
 *
 * Buffering the whole run and slicing afterwards makes the caps a formatting
 * decision, which is too late: the bytes are already held. Counting past the
 * window keeps the reported total exact, which is what makes `offset` paging
 * mean anything, and costs one integer.
 */
async function collectLines(
    stream: ReadableStream<Uint8Array>,
    wanted: number,
    stop: () => void,
): Promise<CollectedLines> {
    const lines: string[] = [];
    let pending = "";
    let total = 0;
    let retainedBytes = 0;
    let longLines = 0;
    let stopped = false;
    const decoder = new TextDecoder("utf-8");
    const reader = stream.getReader();

    // Returns false once nothing further is worth reading.
    const take = (line: string): boolean => {
        if (line.length === 0) {
            return true;
        }
        total += 1;
        if (lines.length < wanted && retainedBytes < MAX_TOTAL_BYTES) {
            const bounded = Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES
                ? `${truncateBytes(line, MAX_LINE_BYTES)} [vera] line truncated`
                : line;
            longLines += bounded === line ? 0 : 1;
            lines.push(bounded);
            retainedBytes += Buffer.byteLength(bounded, "utf8") + 1;
        }
        return total < MAX_SCANNED_LINES;
    };

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            pending += decoder.decode(value, { stream: true });
            const parts = pending.split("\n");
            pending = parts.pop() ?? "";
            let room = true;
            for (const part of parts) {
                room = take(part);
                if (!room) {
                    break;
                }
            }
            if (!room) {
                stopped = true;
                stop();
                break;
            }
        }
        if (!stopped && pending.length > 0) {
            take(pending);
        }
    } finally {
        reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }

    return { lines, total, stopped, longLines };
}

/** Cuts on a byte boundary and drops the decoder's mark at the cut. */
function truncateBytes(line: string, limit: number): string {
    return new TextDecoder("utf-8")
        .decode(Buffer.from(line, "utf8").subarray(0, limit))
        .replace(/\uFFFD+$/, "");
}

/**
 * `Bun.spawn` is called inside this helper rather than assigned to a
 * pre-declared `ReturnType<typeof Bun.spawn>`, because that widens the piped
 * streams back to `number | ReadableStream | undefined` and `new Response(...)`
 * rejects the union. Inferring the return type here keeps them streams.
 */
function spawnRipgrep(args: string[]) {
    try {
        return Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    } catch (error) {
        if (isMissingBinaryError(error)) {
            return null;
        }
        throw error;
    }
}

/**
 * Windows the result lines and says so, so the model can page with `offset`
 * rather than falling back to Bash when a search overflows the cap.
 */
function formatResults(
    collected: CollectedLines,
    maxResults: number,
    offset: number,
): string {
    const lines = collected.lines;
    // A scan Vera abandoned knows how many matches it saw, not how many exist,
    // so its count is marked as a floor rather than reported as the truth.
    const total = collected.stopped
        ? `${collected.total}+`
        : `${collected.total}`;
    const note = collected.longLines === 0
        ? ""
        : `\n(${collected.longLines} long line`
            + `${collected.longLines === 1 ? "" : "s"} cut to `
            + `${MAX_LINE_BYTES} bytes)`;
    if (collected.total === 0) {
        return "(no matches)";
    }
    if (lines.length <= offset) {
        return `(no results at offset ${offset}; ${total} total)`;
    }
    const shown = lines.slice(offset, offset + maxResults);
    const end = offset + shown.length;
    if (offset === 0 && end >= collected.total && !collected.stopped) {
        return `${shown.join("\n")}${note}`;
    }
    return `${shown.join("\n")}\n(showing ${offset + 1}-${end} of `
        + `${total}; pass offset=${end} for more)${note}`;
}

function parseOutputMode(value: unknown): OutputMode {
    if (value === undefined) {
        return "files_with_matches";
    }
    if (typeof value === "string" && isOutputMode(value)) {
        return value;
    }
    throw new Error(
        `grep tool output_mode must be one of ${OUTPUT_MODES.join(", ")}`,
    );
}

function isOutputMode(value: string): value is OutputMode {
    return (OUTPUT_MODES as readonly string[]).includes(value);
}

function parseMaxResults(value: unknown): number {
    if (value === undefined) {
        return DEFAULT_MAX_RESULTS;
    }
    if (
        typeof value !== "number"
        || !Number.isInteger(value)
        || value < 1
    ) {
        throw new Error("grep tool max_results must be a positive integer");
    }
    return Math.min(value, MAX_RESULTS_CAP);
}

/** Shared parser for the optional non-negative integer inputs. */
function parseCount(
    value: unknown,
    field: string,
    min: number,
    max: number,
): number {
    if (value === undefined) {
        return min;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
        throw new Error(
            `grep tool ${field} must be an integer of at least ${min}`,
        );
    }
    return Math.min(value, max);
}

function isMissingBinaryError(value: unknown): boolean {
    return value instanceof Error
        && "code" in value
        && (value as { code?: unknown }).code === "ENOENT";
}

function requiredString(
    input: Readonly<Record<string, unknown>>,
    field: string,
): string {
    const value = input[field];
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`grep tool requires a non-empty string ${field}`);
    }
    return value;
}
