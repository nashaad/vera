import type { VeraClientExtensionApi } from "../../../src/sdk/extensions.ts";
import { createContextView, type ContextView } from "./context-view.ts";
import { registerDashboard } from "./dashboard.ts";

let reportNumber = 0;

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
            let view: ContextView | undefined;
            vera.experimentalTui.appendTranscriptRenderable({
                id: `context-report-${++reportNumber}`,
                create(context) {
                    view = createContextView(context, snapshot, {
                        id: `context-report-root-${reportNumber}`,
                        detail,
                        commandText: detail ? "/context all" : "/context",
                    });
                    return view.root;
                },
                onResize(width) {
                    view?.refresh(width);
                },
            });
            return { kind: "handled" };
        },
    });
}
