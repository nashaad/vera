import type { VeraClientExtensionApi } from "../../src/sdk/extensions.ts";

export function activateClient(vera: VeraClientExtensionApi): void {
    vera.commands.register({
        name: "feedback",
        description: "Report a bug or request a feature",
        usage: "/feedback",
        interactive: true,
        async run({ signal }) {
            const choice = await vera.ui.requestPicker({
                title: "Report a bug or request a feature", layout: "menu", searchable: false,
                rows: [{ id: "bug", label: "Bug" }, { id: "feature", label: "Feature request" }],
                actions: [{ id: "choose", label: "choose", keys: ["enter"] }],
            }, signal);
            if (choice.outcome !== "selected") return { kind: "handled" };
            const title = await vera.experimentalTui.requestSecret({ title: "Title", masked: false }, signal);
            if (title === undefined) return { kind: "handled" };
            const description = await vera.experimentalTui.requestSecret({ title: "Description", masked: false, allowEmpty: true }, signal);
            if (description === undefined) return { kind: "handled" };
            const imagePaths: string[] = [];
            while (imagePaths.length < 4) {
                const image = await vera.experimentalTui.requestSecret({ title: "Image path", hint: "Leave empty to save.", masked: false, allowEmpty: true }, signal);
                if (image === undefined) return { kind: "handled" };
                if (image === "") break;
                imagePaths.push(image);
            }
            try {
                const result = await vera.host.request("save", { kind: choice.rowId, title, description, source: "terminal", image_paths: imagePaths }, signal);
                const record = result as { readonly path?: unknown } | null;
                if (record === null || typeof record !== "object" || typeof record.path !== "string") throw new Error("Restart Vera and try again.");
                return { kind: "text", text: `Report saved on this computer: ${record.path}` };
            } catch (error) {
                const message = error instanceof Error ? error.message : "Could not save the report.";
                return { kind: "text", text: /extension|host did not answer|host connection closed|unsupported|protocol|timeout/i.test(message) ? "Restart Vera and try again." : message };
            }
        },
    });
}
