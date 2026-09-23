import type { VeraClientExtensionApi } from "../../sdk/extensions.ts";
import type { CustomizationSource, SourceCategory } from "../../customize/types.ts";
import { CATEGORIES, sourceStatus, sourceWasLoaded } from "./model.ts";

// "back" means the user pressed Esc on the loaded list, so the caller can reopen its own page.
export type SourceBrowserExit = "back" | "closed";

export function registerSourceBrowser(vera: VeraClientExtensionApi): {
    open(signal: AbortSignal, loadedOnly?: boolean): Promise<SourceBrowserExit>;
} {
    let generation = 0;
    let finishPreview: (() => void) | undefined;
    vera.conversation.onChanged(() => { generation += 1; finishPreview?.(); });
    return {
        async open(signal, loadedOnly = false) {
            const version = ++generation;
            let category: SourceCategory | undefined;
            let selectedId: string | undefined;
            while (!signal.aborted && version === generation) {
                const catalog = await vera.context.sources(signal);
                if (signal.aborted || version !== generation) return "closed";
                const snapshot = vera.context.current();
                if (category === undefined && !loadedOnly) {
                    const choice = await vera.ui.requestPicker({
                        title: "Customize",
                        rows: CATEGORIES.map((item) => ({
                            id: item.id, label: item.name,
                            description: `${catalog.sources.filter((source) => source.category === item.id).length} available`,
                        })),
                        actions: [{ id: "open", label: "open", keys: ["enter"] }],
                    }, signal);
                    if (choice.outcome === "cancelled") return "closed";
                    category = choice.rowId as SourceCategory;
                    selectedId = undefined;
                    continue;
                }
                const sources = catalog.sources.filter((source) => loadedOnly
                    ? sourceWasLoaded(source, snapshot) : source.category === category);
                const title = loadedOnly ? "Context › Loaded sources"
                    : `Customize › ${CATEGORIES.find((item) => item.id === category)!.name}`;
                const rows = sources.map((source, index) => ({
                    id: `source-${index}`, label: source.name,
                    description: `${source.scope} · ${sourceStatus(source, snapshot)} · ${source.description} ${source.path ?? ""}`,
                }));
                const notices = catalog.warnings.length === 0 ? undefined : catalog.warnings.join("\n");
                const choice = await vera.ui.requestPicker({
                    title, searchable: true,
                    ...(notices === undefined ? {} : { subtitle: notices }),
                    rows: rows.length > 0 ? rows : [{ id: "empty", label: "No sources available", description: loadedOnly ? "No individual loaded sources in the measured request." : "This catalog is empty." }],
                    ...(rows.some((row) => row.id === selectedId) ? { selectedId } : {}),
                    actions: [{ id: "preview", label: "preview", keys: ["enter"] }],
                }, signal);
                if (choice.outcome === "cancelled") {
                    if (loadedOnly) return "back";
                    category = undefined;
                    continue;
                }
                selectedId = choice.rowId;
                let source = sources[rows.findIndex((row) => row.id === selectedId)];
                if (source === undefined) continue;
                await new Promise<void>((resolve) => {
                    const finish = (): void => {
                        signal.removeEventListener("abort", finish);
                        finishPreview = undefined;
                        resolve();
                    };
                    finishPreview = finish;
                    signal.addEventListener("abort", finish, { once: true });
                    const show = (notice?: string): void => {
                        if (signal.aborted || version !== generation) { finish(); return; }
                        vera.experimentalTui.openDocument({
                            title: `${title} › ${source!.name}`,
                            markdown: sourceDocument(source!, sourceStatus(source!, snapshot)),
                            footerText: notice ?? "Current saved contents. Esc back.",
                            ...(source!.editable && source!.path !== undefined ? { editorPath: source!.path } : {}),
                            onClose: finish,
                            async onEditorClosed() {
                                const refreshed = await vera.context.sources(signal);
                                const found = refreshed.sources.find((candidate) => candidate.id === source!.id);
                                if (found === undefined) show("The saved definition is no longer in the catalog. Go back to see its notices.");
                                else { source = found; show(); }
                            },
                        });
                    };
                    show();
                });
            }
            return "closed";
        },
    };
}

export function sourceDocument(source: CustomizationSource, status: string): string {
    const fence = "`".repeat(Math.max(3, ...[...source.content.matchAll(/`+/g)].map((match) => match[0].length + 1)));
    return `Scope: ${source.scope}\n\nStatus: ${status}\n\nSource: ${source.path ?? "Provided by an extension"}\n\n${fence}\n${source.content || "(Empty file)"}\n${fence}`;
}
