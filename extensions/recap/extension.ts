import type {
    VeraClientExtensionApi,
    VeraClientExtensionCommandHandler,
    VeraClientPickerRow,
} from "../../src/sdk/extensions.ts";
import { buildRecap } from "./model.ts";
import { recapRows, recapSubtitle } from "./rows.ts";

export function activateClient(vera: VeraClientExtensionApi): void {
    // Per conversation, so reopening starts where the last jump landed.
    let lastJumped: string | undefined;
    vera.conversation.onChanged(() => {
        lastJumped = undefined;
    });

    const open: VeraClientExtensionCommandHandler = async ({ signal }) => {
        const phases = buildRecap(vera.thread.entries(), Date.now());
        if (phases.length === 0) return { kind: "text", text: "Nothing to recap yet." };
        const rows = recapRows(phases);
        const pickerRows: VeraClientPickerRow[] = rows.map(({ target: _target, ...row }) => row);
        const selectedId = rows.some((row) => row.id === lastJumped) ? lastJumped : rows.at(-1)?.id;
        const result = await vera.ui.requestPicker({
            title: "Recap",
            subtitle: recapSubtitle(phases),
            layout: "list-detail",
            size: "full",
            searchable: true,
            searchPlaceholder: "Search phases",
            rows: pickerRows,
            ...(selectedId === undefined ? {} : { selectedId }),
            actions: [{ id: "jump", label: "jump", keys: ["enter"] }],
        }, signal);
        if (result.outcome !== "selected") return { kind: "handled" };
        const row = rows.find((candidate) => candidate.id === result.rowId);
        if (row === undefined) return { kind: "handled" };
        lastJumped = row.id;
        if (vera.ui.reveal(row.target)) return { kind: "handled" };
        return { kind: "text", text: "That part of the conversation is not in this transcript anymore." };
    };

    vera.commands.register({
        name: "recap",
        description: "Show this conversation as phases and jump to one",
        usage: "/recap",
        interactive: true,
        palette: { label: "Recap this conversation", group: "Session" },
        run: open,
    });
    vera.commands.register({
        name: "timeline",
        description: "Same as /recap",
        usage: "/timeline",
        interactive: true,
        run: open,
    });
}
