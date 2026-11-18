import type { VeraClientExtensionApi, VeraClientPickerRow } from "../../../../src/sdk/extensions.ts";

export function activateClient(vera: VeraClientExtensionApi): void {
    vera.commands.register({
        name: "thread-history",
        description: "Load and show conversation entries",
        usage: "/thread-history",
        interactive: true,
        async run({ signal }) {
            try {
                while (vera.thread.hasEarlier) await vera.thread.loadEarlier(signal);
            } catch (error) {
                if (error instanceof Error && error.name === "AbortError") return { kind: "handled" };
                return { kind: "text", text: error instanceof Error ? error.message : String(error) };
            }
            const rows: VeraClientPickerRow[] = vera.thread.entries().flatMap((entry) =>
                entry.kind === "user" && entry.id !== undefined
                    ? [{ id: entry.id, label: entry.text }]
                    : []);
            const selected = await vera.ui.requestPicker({
                title: "Thread history",
                searchable: true,
                searchPlaceholder: "Search entries",
                rows,
                actions: [{ id: "jump", label: "jump", keys: ["enter"] }],
            }, signal);
            if (selected.outcome === "selected") await vera.ui.reveal({ entryId: selected.rowId });
            return { kind: "handled" };
        },
    });
}
