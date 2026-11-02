import type { ProviderFailure } from "../model/provider-failure.ts";
import { sanitizeDiagnosticText } from "../model/diagnostic-text.ts";

const BODY_LIMIT = 4_096;

export interface ProviderHttpError extends Error {
    readonly status: number;
    readonly body: string;
}

export async function providerHttpError(
    label: string,
    response: Response,
): Promise<ProviderHttpError> {
    const body = (await response.text()).slice(0, BODY_LIMIT).trim();
    const error = new Error(
        `${label} returned HTTP ${response.status}${body ? `: ${body}` : ""}`,
    ) as Error & { status: number; body: string };
    error.status = response.status;
    error.body = body;
    return error;
}

const REASON_LIMIT = 240;

// The provider's own words for a failure, so a bare status code is not all the user sees.
export async function providerHttpReason(response: Response): Promise<string | undefined> {
    const body = (await response.text()).slice(0, BODY_LIMIT).trim();
    if (body.length === 0) return undefined;
    const { providerMessage } = providerHttpDiagnostics({ body });
    const message = providerMessage ?? firstLine(body);
    if (message === undefined) return undefined;
    return message.length <= REASON_LIMIT ? message : `${message.slice(0, REASON_LIMIT)}…`;
}

// An error page is markup rather than a message, so it falls back to the status alone.
function firstLine(body: string): string | undefined {
    const line = body.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0);
    if (line === undefined || line.startsWith("<")) return undefined;
    return sanitizeDiagnosticText(line);
}

type HttpErrorDiagnostics = Pick<ProviderFailure, "providerMessage" | "providerCode">;

// Reads the common {"error": {"message", "type" | "code"}} envelope, or a bare {"message"}.
export function providerHttpDiagnostics(value: unknown): HttpErrorDiagnostics {
    const body = typeof value === "object" && value !== null
        ? (value as { body?: unknown }).body
        : undefined;
    const parsed = typeof body === "string" ? parseRecord(body) : undefined;
    if (parsed === undefined) return {};
    const envelope = isRecord(parsed.error) ? parsed.error : parsed;
    const message = textField(envelope, "message")
        ?? (typeof parsed.error === "string" && parsed.error.length > 0 ? parsed.error : undefined);
    const code = textField(envelope, "type") ?? textField(envelope, "code");
    return {
        ...(message === undefined ? {} : { providerMessage: sanitizeDiagnosticText(message) }),
        ...(code === undefined ? {} : { providerCode: sanitizeDiagnosticText(code) }),
    };
}

function parseRecord(text: string): Record<string, unknown> | undefined {
    try {
        const parsed: unknown = JSON.parse(text);
        return isRecord(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

function textField(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
