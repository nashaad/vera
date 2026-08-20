interface AgentSuggestionRule {
    readonly terms: readonly string[];
    readonly agent: string;
    readonly hint: string;
    readonly fromAgents?: readonly string[];
}

/** This extension is client-only, but the shared loader expects both exports. */
export function activate(_vera: any): void {}

export function activateClient(vera: any): void {
    for (const rule of agentSuggestionRules(vera.config)) {
        const patterns = rule.terms.map(termPattern);
        vera.compose.registerSuggester({
            agent: rule.agent,
            hint: rule.hint,
            ...(rule.fromAgents === undefined
                ? {}
                : { fromAgents: rule.fromAgents }),
            match(text: string) {
                return patterns.some((pattern) => pattern.test(text));
            },
        });
    }
}

export function agentSuggestionRules(value: unknown): readonly AgentSuggestionRule[] {
    if (!isRecord(value) || !Array.isArray(value.rules)) return [];
    return value.rules.flatMap((candidate) => {
        if (!isRecord(candidate)) return [];
        const terms = stringList(candidate.terms);
        const fromAgents = candidate.from_agents === undefined
            ? undefined
            : stringList(candidate.from_agents);
        if (
            terms === undefined
            || typeof candidate.agent !== "string"
            || candidate.agent.trim().length === 0
            || typeof candidate.hint !== "string"
            || candidate.hint.trim().length === 0
            || (candidate.from_agents !== undefined && fromAgents === undefined)
        ) {
            return [];
        }
        return [{
            terms,
            agent: candidate.agent.trim(),
            hint: candidate.hint.trim(),
            ...(fromAgents === undefined ? {} : { fromAgents }),
        }];
    });
}

function termPattern(term: string): RegExp {
    const escaped = term
        .split(/\s+/u)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("\\s+");
    return new RegExp(
        `(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`,
        "iu",
    );
}

function stringList(value: unknown): readonly string[] | undefined {
    if (!Array.isArray(value) || value.length === 0) return undefined;
    const normalized = value.map((entry) =>
        typeof entry === "string" ? entry.trim() : ""
    );
    if (normalized.some((entry) => entry.length === 0)) return undefined;
    return [...new Set(normalized)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
