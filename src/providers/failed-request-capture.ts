import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ProviderFailure } from "../model/provider-failure.ts";
import { veraRuntimeDirectory } from "../profile-paths.ts";

export type FailedRequestOutcome = "provider_error" | "empty_response";

export interface FailedRequestDetail {
    readonly provider: string;
    readonly api: string;
    readonly model: string;
    readonly outcome: FailedRequestOutcome;
    readonly error?: string;
    readonly failure?: ProviderFailure;
    readonly request: unknown;
    readonly response: readonly unknown[];
    readonly responseTruncated?: boolean;
}

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

/** A per-session sink for provider requests that failed. Both caps are load-bearing rather than tidiness: a turn that retries against a provider returning the same error would. */
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

function serializeCapture(file: CaptureFile, maxBytes: number): string {
    const full = encode(redactSecrets(file));
    if (byteLength(full) <= maxBytes) {
        return full;
    }
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

const AUTH_HEADER = new RegExp(
    "\\b("
    + "authorization|proxy-authorization|www-authenticate"
    + "|cookie|set-cookie"
    + ")(\\s*:\\s*)[^\\n\"',;]+",
    "gi",
);
const BEARER = /\bBearer\s+[\w\-._~+/:]+=*/gi;
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
const SECRET_ASSIGNMENT = new RegExp(
    "\\b([A-Za-z0-9_-]*"
    + "(?:key|token|secret|password|passwd|credential)s?"
    + "[A-Za-z0-9_-]*)"
    + "(\\s*[=:]\\s*)"
    + "(\"[^\"\\n]+\"|'[^'\\n]+'|[^\\s\"',;]+)",
    "gi",
);

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
