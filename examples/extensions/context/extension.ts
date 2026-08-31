import type { VeraClientExtensionApi } from "../../../src/sdk/extensions.ts";
import { contextReportMarkdown } from "./context-report.ts";
import { registerDashboard } from "./dashboard.ts";

export function activateClient(vera: VeraClientExtensionApi): void {
    registerDashboard(vera);
    vera.commands.register({
        name: "context",
        description: "Show context usage",
        usage: "/context [all]",
        run({ argumentsText }) {
            const argument = argumentsText.trim();
            if (argument !== "" && argument !== "all") {
                return {
                    kind: "text",
                    text: "Usage: /context [all]",
                };
            }
            const detail = argument === "all";
            const snapshot = vera.context.current();
            vera.experimentalTui.openDocument({
                title: "Context",
                footerText: "Last measured request.",
                markdown: (columns) =>
                    contextReportMarkdown(snapshot, detail, columns),
            });
            return { kind: "handled" };
        },
    });
}
