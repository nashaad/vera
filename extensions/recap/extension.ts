import type {
    VeraClientExtensionApi,
    VeraClientExtensionCommandHandler,
    VeraClientPickerRow,
    VeraExtensionApi,
} from "../../src/sdk/extensions.ts";
import { LABEL_PROMPT, labelMessage, labelRequest, MAX_LABELLED_PHASES, parseLabels, readLabelRequest } from "./labels.ts";
import { buildRecap, type RecapPhase } from "./model.ts";
import { recapRows, recapSubtitle } from "./rows.ts";

const LABEL_REQUEST = "label";
const LABEL_TIMEOUT_MS = 15_000;

export function activate(vera: VeraExtensionApi): void {
    vera.requests.handle(LABEL_REQUEST, async (payload, { signal }) => {
        const request = readLabelRequest(payload);
        if (request === undefined) throw new Error("Malformed recap label request.");
        const result = await vera.model.oneshot({
            assignment: "snappy",
            systemPrompt: LABEL_PROMPT,
            messages: [{ role: "user", text: labelMessage(request) }],
            signal,
        });
        return parseLabels(result.text, request.phases.length).map((label) => label ?? null);
    });
}

export function activateClient(vera: VeraClientExtensionApi): void {
    // Per conversation, so reopening starts where the last jump landed.
    let lastJumped: string | undefined;
    vera.conversation.onChanged(() => {
        lastJumped = undefined;
    });
    // Phase keys are entry ids, so titles stay valid across conversation switches.
    const labels = new Map<string, string>();

    const label = async (phases: readonly RecapPhase[], signal: AbortSignal): Promise<void> => {
        const wanted = phases
            .filter((phase) => phase.key !== undefined && !labels.has(phase.key))
            .slice(-MAX_LABELLED_PHASES);
        if (wanted.length === 0) return;
        const first = phases.indexOf(wanted[0]!);
        const earlier = phases.slice(0, first).flatMap((phase) => {
            const known = phase.key === undefined ? undefined : labels.get(phase.key);
            return known === undefined ? [] : [known];
        });
        try {
            const answer = await vera.host.request(
                LABEL_REQUEST,
                labelRequest(wanted, earlier),
                AbortSignal.any([signal, AbortSignal.timeout(LABEL_TIMEOUT_MS)]),
            );
            if (!Array.isArray(answer)) return;
            wanted.forEach((phase, index) => {
                const text = answer[index];
                if (typeof text === "string" && phase.key !== undefined) labels.set(phase.key, text);
            });
        } catch {
            // No snappy model, a timeout or a bad answer all leave the built titles.
        }
    };

    const open: VeraClientExtensionCommandHandler = async ({ signal }) => {
        const built = buildRecap(vera.thread.entries(), Date.now());
        if (built.length === 0) return { kind: "text", text: "Nothing to recap yet." };
        await label(built, signal);
        if (signal.aborted) return { kind: "handled" };
        const phases = built.map((phase) => {
            const known = phase.key === undefined ? undefined : labels.get(phase.key);
            return known === undefined ? phase : { ...phase, title: known };
        });
        const rows = recapRows(phases);
        const pickerRows: VeraClientPickerRow[] = rows.map(({ target: _target, ...row }) => row);
        const selectedId = rows.some((row) => row.id === lastJumped) ? lastJumped : rows[0]?.id;
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
