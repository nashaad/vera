import type { VeraClientExtensionApi } from "../../../src/sdk/extensions.ts";
import { contextReportMarkdown } from "./context-report.ts";
import { buildContextDeep } from "./deep.ts";
import { contextDeepMarkdown } from "./deep-markdown.ts";
import { registerDashboard } from "./dashboard.ts";

export function activateClient(vera: VeraClientExtensionApi): void {
    registerDashboard(vera);
    vera.commands.register({
        name: "context",
        description: "Show context usage. /context deep is experimental.",
        usage: "/context [all]",
        // Deep waits on oneshot. Occupancy still returns in the same turn.
        interactive: true,
        async run({ argumentsText, workspace }) {
            const argument = argumentsText.trim();
            if (argument === "deep") {
                return runDeep(vera, workspace);
            }
            if (argument !== "" && argument !== "all") {
                return {
                    kind: "text",
                    text: "Usage: /context [all|deep]",
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

async function runDeep(
    vera: VeraClientExtensionApi,
    workspace: string,
): Promise<{ kind: "handled" }> {
    const snapshot = vera.context.current();
    const model = snapshot.model === undefined
        ? undefined
        : {
            model: snapshot.model.model,
            ...(snapshot.model.provider === undefined
                ? {}
                : { provider: snapshot.model.provider }),
        };
    const report = await buildContextDeep({
        workspace,
        oneshot: vera.oneshot,
        ...(model === undefined ? {} : { model }),
    });
    vera.experimentalTui.openDocument({
        title: "Deep",
        footerText: "experimental · instruction pile for this workspace",
        markdown: (columns) => contextDeepMarkdown(report, columns),
    });
    return { kind: "handled" };
}
