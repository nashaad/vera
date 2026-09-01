const MAX_DIAGNOSTIC_LENGTH = 4_096;

export function sanitizeDiagnosticText(value: string): string {
    const redacted = value
        .replace(/\bBearer\s+[^\s,;}]+/gi, "Bearer [REDACTED]")
        .replace(
            /\b(authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|secret|password)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^,;}\r\n]+)/gi,
            "$1$2[REDACTED]",
        )
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_API_KEY]")
        .replace(
            /(?:[A-Za-z0-9+/=_-]{32,}[ \t\r\n]+)+[A-Za-z0-9+/=_-]{32,}/g,
            "[REDACTED_BINARY]",
        )
        .replace(/data:[^;,\s]+;base64,[A-Za-z0-9+/=_-]+/gi, "[REDACTED_BINARY]")
        .replace(/[A-Za-z0-9+/_=-]{128,}/g, "[REDACTED_BINARY]");
    return redacted.length <= MAX_DIAGNOSTIC_LENGTH
        ? redacted
        : `${redacted.slice(0, MAX_DIAGNOSTIC_LENGTH)}…[TRUNCATED]`;
}
