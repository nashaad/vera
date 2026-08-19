import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ProviderFailure } from "../model/provider-failure.ts";
import { veraRuntimeDirectory } from "../profile-paths.ts";

/** Why a request was kept. */
export type FailedRequestOutcome = "provider_error" | "empty_response";

export interface FailedRequestDetail {
    readonly provider: string;
    readonly api: string;
    readonly model: string;
    readonly outcome: FailedRequestOutcome;
    readonly error?: string;
    readonly failure?: ProviderFailure;
    /** The body as it was handed to the provider client. */
    readonly request: unknown;
    /** Raw chunks the provider sent before it failed, oldest first. */
    readonly response: readonly unknown[];
    readonly responseTruncated?: boolean;
}

/** Writes one capture and answers with its path, or nothing when it wrote none. */
export type FailedRequestCapture = (
    detail: FailedRequestDetail,
) => string | undefined;

export interface FailedRequestCaptureOptions {
    readonly sessionId: string;
    readonly directory?: string;
    readonly maxCaptures?: number;
    readonly maxBytes?: number;
    readonly now?: () => Date;
}

export const DEFAULT_MAX_CAPTURES_PER_SESSION = 5;
export const DEFAULT_MAX_CAPTURE_BYTES = 256 * 1024;

export function defaultCaptureDirectory(): string {
    return join(veraRuntimeDirectory(), "logs", "captures");
}

/**
 * A per-session sink for provider requests that failed.
 *
 * Both caps are load-bearing rather than tidiness: a turn that retries against
 * a provider returning the same error would otherwise write one file per
 * attempt, and a request carrying a long transcript is megabytes each time.
 * A failed write answers with nothing, so a full disk loses the capture and
 * not the turn.
 */
export function createFailedRequestCapture(
    options: FailedRequestCaptureOptions,
): FailedRequestCapture {
    const directory = options.directory ?? defaultCaptureDirectory();
    const maxCaptures = options.maxCaptures ?? DEFAULT_MAX_CAPTURES_PER_SESSION;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
    const now = options.now ?? (() => new Date());
    let written = 0;

    return (detail) => {
        if (written >= maxCaptures) {
            return undefined;
        }
        const index = written + 1;
        const path = join(directory, `${options.sessionId}-${index}.json`);
        try {
            mkdirSync(directory, { recursive: true, mode: 0o700 });
            chmodSync(directory, 0o700);
            writeFileSync(
                path,
                serializeCapture(
                    {
                        format_version: 1,
                        timestamp: now().toISOString(),
                        session_id: options.sessionId,
                        capture: index,
                        max_captures: maxCaptures,
                        ...detail,
                    },
                    maxBytes,
                ),
                { encoding: "utf8", mode: 0o600 },
            );
        } catch {
            return undefined;
        }
        written = index;
        return path;
    };
}

interface CaptureFile extends FailedRequestDetail {
    readonly format_version: 1;
    readonly timestamp: string;
    readonly session_id: string;
    readonly capture: number;
    readonly max_captures: number;
}

/**
 * The capture as JSON, never longer than `maxBytes`.
 *
 * Parts are dropped whole so the file stays parseable: clipping the encoded
 * text would leave a JSON document nothing can read, which is the one thing a
 * capture cannot afford to be.
 */
function serializeCapture(file: CaptureFile, maxBytes: number): string {
    const full = encode(redactSecrets(file));
    if (byteLength(full) <= maxBytes) {
        return full;
    }
    // The request is the transcript, which the session store already holds;
    // the response is the provider behavior nothing else recorded. So the
    // request goes first, and the response gives ground only from its head:
    // the chunk that explains a failure is almost always the last one.
    const withoutRequest = encode(redactSecrets({
        ...file,
        request: null,
        omitted: "request exceeded the capture byte cap",
    }));
    if (byteLength(withoutRequest) <= maxBytes) {
        return withoutRequest;
    }
    let tail = file.response;
    while (tail.length > 0) {
        tail = tail.slice(Math.ceil(tail.length / 2));
        const trimmed = encode(redactSecrets({
            ...file,
            request: null,
            response: tail,
            responseTruncated: true,
            omitted: "request and the response head exceeded the capture byte cap",
        }));
        if (byteLength(trimmed) <= maxBytes) {
            return trimmed;
        }
    }
    return encode(redactSecrets({
        ...file,
        request: null,
        response: [],
        omitted: "request and response exceeded the capture byte cap",
    }));
}

function encode(value: unknown): string {
    return `${JSON.stringify(value, undefined, 2)}\n`;
}

function byteLength(value: string): number {
    return Buffer.byteLength(value, "utf8");
}

export const REDACTED = "[redacted]";

const SECRET_KEY = new RegExp(
    "^("
    + "authorization|proxy-authorization|www-authenticate"
    + "|cookie|set-cookie"
    + "|x-api-key|api[-_]?key|apikey"
    + "|access[-_]?token|refresh[-_]?token|id[-_]?token"
    + "|client[-_]?secret|secret|password"
    + ")$",
    "i",
);

// Header lines carrying a credential, whatever scheme or shape the value has.
// The value runs to the end of the line, stopping at a quote or separator so a
// header inside a serialized object does not swallow its neighbours.
const AUTH_HEADER = new RegExp(
    "\\b("
    + "authorization|proxy-authorization|www-authenticate"
    + "|cookie|set-cookie"
    + ")(\\s*:\\s*)[^\\n\"',;]+",
    "gi",
);
// Bearer credentials wherever they appear, header or not. The colon is inside
// the value class because a token can carry one and the tail is as secret as
// the head. Other schemes are left to the header pass: their names are common
// enough as prose that matching them loose would redact message content.
const BEARER = /\bBearer\s+[\w\-._~+/:]+=*/gi;
// Well-known token shapes. Captured requests carry prior tool output, so a
// key can arrive as a bare literal (an `env` dump, a read .env file) with no
// header name or Bearer prefix around it.
const KEY_LITERAL = new RegExp(
    "\\b(?:"
    + "sk-[A-Za-z0-9\\-_]{8,}"
    + "|gh[pousr]_[A-Za-z0-9]{20,}"
    + "|github_pat_[A-Za-z0-9_]{20,}"
    + "|xox[baprs]-[A-Za-z0-9-]{10,}"
    + "|glpat-[A-Za-z0-9\\-_]{20,}"
    + "|npm_[A-Za-z0-9]{30,}"
    + "|AKIA[0-9A-Z]{16}"
    + ")\\b",
    "g",
);
// `NAME=value` / `NAME: value` lines inside strings, for secrets whose value
// has no recognizable shape (AWS secret keys, arbitrary passwords). The name
// is the signal there, same as the object-key pass below.
const SECRET_ASSIGNMENT = new RegExp(
    "\\b([A-Za-z0-9_-]*"
    + "(?:key|token|secret|password|passwd|credential)s?"
    + "[A-Za-z0-9_-]*)"
    + "(\\s*[=:]\\s*)"
    + "(\"[^\"\\n]+\"|'[^'\\n]+'|[^\\s\"',;]+)",
    "gi",
);

/**
 * Credentials out, message content in.
 *
 * The bodies here are the user's own conversation, which is the whole reason
 * the file is worth reading, so only the fields and literals that carry a
 * provider credential are replaced. The literal pass matters because a key
 * reaches a capture inside an error string as often as it does under a header
 * name, and a bare `key=` in a query string is a credential as often as a
 * named one is.
 */
export function redactSecrets(value: unknown): unknown {
    if (typeof value === "string") {
        return value.replace(AUTH_HEADER, `$1$2${REDACTED}`)
            .replace(BEARER, `Bearer ${REDACTED}`)
            .replace(KEY_LITERAL, REDACTED)
            .replace(SECRET_ASSIGNMENT, `$1$2${REDACTED}`);
    }
    if (Array.isArray(value)) {
        return value.map((entry) => redactSecrets(entry));
    }
    if (value instanceof Error) {
        return redactSecrets({
            name: value.name,
            message: value.message,
            ...(value.stack === undefined ? {} : { stack: value.stack }),
        });
    }
    if (typeof value !== "object" || value === null) {
        return value;
    }
    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
        redacted[key] = SECRET_KEY.test(key)
            ? REDACTED
            : redactSecrets(entry);
    }
    return redacted;
}
