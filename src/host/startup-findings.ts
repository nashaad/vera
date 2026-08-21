import type { PromptContribution } from "../engine/prompt-contributions.ts";
import { redactSecretShapedText } from "../extensions/literal-secret.ts";

/** Beyond this the note is more noise than help. */
const MAX_FINDINGS = 32;

export interface StartupFinding {
    readonly extensionId: string;
    readonly detail: string;
}

/**
 * What extension startup found, held for the sessions that come after it.
 * Startup happens before any session exists, so without this the findings
 * reach only `host.jsonl`, where nothing acts on them.
 */
export class StartupFindings {
    private readonly findings: StartupFinding[] = [];
    private truncated = 0;

    record(finding: StartupFinding): void {
        if (this.findings.length >= MAX_FINDINGS) {
            this.truncated += 1;
            return;
        }
        this.findings.push({
            extensionId: redactSecretShapedText(finding.extensionId),
            detail: redactSecretShapedText(finding.detail),
        });
    }

    contributions(): readonly PromptContribution[] {
        if (this.findings.length === 0) {
            return [];
        }
        return [{
            id: "host.startup_findings",
            owner: "host",
            target: "contextual",
            title: "Extension startup",
            content: renderStartupFindings(this.findings, this.truncated),
        }];
    }
}

export function renderStartupFindings(
    findings: readonly StartupFinding[],
    truncated = 0,
): string {
    const lines = [
        "Loading this host's extensions turned up the following. Raise it with the user when it is relevant, and offer to fix it.",
        "",
    ];
    for (const finding of findings) {
        lines.push(`- ${finding.extensionId}: ${finding.detail}`);
    }
    if (truncated > 0) {
        lines.push(`- ${truncated} more not listed here; the rest are in host.jsonl`);
    }
    return lines.join("\n");
}

/** How a literal credential in extension config reads in the note. */
export function literalSecretDetail(
    configPath: string,
    prefix: string,
): string {
    const where = configPath === "" ? "its config" : `config.${configPath}`;
    return `${where} holds a value beginning \`${prefix}\`, which looks like a credential written into the config file. `
        + "Config can be shared or committed, so suggest moving the value to an environment variable and referencing it as {env:NAME}.";
}
