import { registerSourceBrowser } from "../customize/view.ts";
import type { VeraClientExtensionApi } from "../../sdk/extensions.ts";
import { contextReportMarkdown } from "./context-report.ts";
import { watchInstructionBudget } from "./instruction-budget-notice.ts";
import { configuredInstructionBudget } from "./instruction-budget.ts";
import { registerDashboard } from "./dashboard.ts";

export function activateClient(vera: VeraClientExtensionApi): void {
    const budgetTokens = configuredInstructionBudget(vera.config);
    registerDashboard(vera);
    watchInstructionBudget(vera, budgetTokens);
    const browser = registerSourceBrowser(vera);
    vera.commands.register({
        name: "context",
        interactive: true,
        description: "Show context usage",
        usage: "/context [all|sources]",
        async run({ argumentsText, signal }) {
            const argument = argumentsText.trim();
            if (argument === "sources") {
                await browser.open(signal, true);
                return { kind: "handled" };
            }
            if (argument !== "" && argument !== "all") {
                return {
                    kind: "text",
                    text: "Usage: /context [all|sources]",
                };
            }
            const detail = argument === "all";
            const snapshot = vera.context.current();
            vera.experimentalTui.openDocument({
                title: "Context",
                footerText: "Last measured request.",
                action: { label: "loaded sources", run: () => browser.open(new AbortController().signal, true) },
                markdown: (columns) =>
                    contextReportMarkdown(snapshot, detail, columns, budgetTokens),
            });
            return { kind: "handled" };
        },
    });
}
