import { loadStandingNudges, type StandingNudge } from "../../../src/standing-nudges.ts";
import type { IdentifiedTuiAgentClient } from "../agent-client.ts";
import type { TuiAgentPane } from "../agent-pane.ts";
import type { TuiCommandAction, TuiCommandCatalogEntry, TuiPaletteEntry } from "../commands.ts";
import { TUI_COMPOSER_MAX_TEXT_ROWS, TUI_COMPOSER_MIN_TEXT_ROWS, tuiComposerPanelRows } from "../composer.ts";
import { markTuiGutterEntry, unmarkTuiGutterEntry } from "../gutter.ts";
import { isHomeClient } from "../home-client.ts";
import { isJsonlViewClient, isWorkerFreeClient } from "../jsonl-view-client.ts";
import { resolveTuiKeymap } from "../keybindings.ts";
import { installTuiKeymap, isTuiKeyScope } from "../keymap.ts";
import { RESUME_VIEWED_PALETTE_ENTRY, forgetPersistedAgentPane, rejectPendingExtensionSettingsFor, renderState, setSidebarFocused } from "../main.ts";
import type { TuiStandingNudgesState } from "../standing-nudges.ts";
import { appendTuiNotice, transcriptMessageId, type TuiTranscriptEntry } from "../state.ts";
import { markTuiUserEntry, unmarkTuiUserEntry } from "../user-entry.ts";
import type { TuiRuntime } from "./runtime.ts";
import { SyntaxStyle, type BoxRenderable, type Renderable } from "@opentui/core";

export function applyTerminalTitle(rt: TuiRuntime): void {
    rt.renderer.setTerminalTitle(
        rt.sessionTitle === undefined || rt.sessionTitle.length === 0
            ? "Vera"
            : `${rt.sessionTitle} · Vera`,
    );
}

export function fallbackSessionTitle(rt: TuiRuntime, text: string): string | undefined {
    const title = text.replaceAll(/\s+/g, " ").trim().slice(0, 80);
    return title.length === 0 ? undefined : title;
}

export function adoptFallbackSessionTitle(rt: TuiRuntime, 
    text: string,
    injectedPrefix?: number,
): void {
    if (rt.sessionTitle !== undefined) {
        return;
    }
    const visible = injectedPrefix !== undefined
            && injectedPrefix > 0
            && injectedPrefix < text.length
        ? text.slice(injectedPrefix)
        : text;
    const title = fallbackSessionTitle(rt, visible);
    if (title === undefined) {
        return;
    }
    rt.sessionTitle = title;
    applyTerminalTitle(rt);
}

export function refreshTerminalTitle(rt: TuiRuntime): void {
    const agentId = rt.client.agentId;
    if (agentId === undefined || rt.dependencies.listAgents === undefined) {
        return;
    }
    void rt.dependencies.listAgents().then((agents) => {
        if (rt.shuttingDown || agentId !== rt.client.agentId) {
            return;
        }
        rt.sessionTitle = agents.find((agent) => agent.id === agentId)?.title;
        applyTerminalTitle(rt);
        if (rt.clientSurfaceReady) renderState(rt);
    }).catch(() => {
    });
}

export function toggleMainHeader(rt: TuiRuntime): void {
    rt.mainHeaderVisible = !rt.mainHeaderVisible;
    renderState(rt);
}

export function toggleSidebarHeader(rt: TuiRuntime): void {
    if (rt.hostedSidebar.pane === undefined) return;
    rt.sidebarHeaderVisible = !rt.sidebarHeaderVisible;
    renderState(rt);
}

export function readStandingNudgeRules(rt: TuiRuntime): readonly StandingNudge[] {
    try {
        return loadStandingNudges(rt.standingNudgesProfileDirectory);
    } catch {
        // The dialog and hosted turn own the actionable file error. The ambient indicator must not turn a corrupt profile into a second competing error surface.
        return [];
    }
}

export function adoptStandingNudgesState(rt: TuiRuntime, 
    next: TuiStandingNudgesState | undefined,
): void {
    rt.standingNudges = next;
    if (next === undefined) return;
    rt.standingNudgeRules = next.screen === "error"
        ? next.back?.nudges ?? []
        : next.nudges;
}

export function isSearchLanding(rt: TuiRuntime, entry: TuiTranscriptEntry): boolean {
    return rt.searchLanding !== undefined
        && rt.client.agentId === rt.searchLanding.sessionId
        && entry.kind !== "diff"
        && transcriptMessageId(entry.entryId) === rt.searchLanding.entryId;
}

export function markSearchLanding(rt: TuiRuntime, 
    entry: TuiTranscriptEntry,
    node: Renderable,
): boolean {
    return entry.kind === "user"
        ? markTuiUserEntry(node as BoxRenderable)
        : markTuiGutterEntry(node);
}

export function clearSearchLanding(rt: TuiRuntime): void {
    if (rt.searchLanding === undefined) return;
    const index = rt.state.entries.findIndex(((entry: TuiTranscriptEntry) => isSearchLanding(rt, entry)));
    rt.searchLanding = undefined;
    const entry = rt.state.entries[index];
    const node = rt.entryNodes[index];
    if (entry === undefined || node === undefined) return;
    if (entry.kind === "user") {
        unmarkTuiUserEntry(node as BoxRenderable);
    } else {
        unmarkTuiGutterEntry(node, entry);
    }
}

export function appendPendingSidebarContextNotice(rt: TuiRuntime, 
    side: TuiAgentPane<IdentifiedTuiAgentClient>,
): void {
    const notice = rt.pendingSidebarContextNotice;
    if (notice?.agentId !== side.agentId) return;
    side.state.state = appendTuiNotice(
        side.state.state,
        notice.text,
        "soft",
    );
    rt.pendingSidebarContextNotice = undefined;
}

export function refreshKeymap(rt: TuiRuntime): void {
    const resolution = resolveTuiKeymap({
        extensions: (rt.clientExtensionRegistry?.keybindings() ?? []).map(
            (descriptor) => ({
                id: descriptor.id,
                keys: descriptor.keys,
                description: descriptor.description,
                ...(isTuiKeyScope(descriptor.scope)
                    ? { scope: descriptor.scope }
                    : {}),
                ...(descriptor.remappable === undefined
                    ? {}
                    : { remappable: descriptor.remappable }),
                ...(descriptor.hint === undefined
                    ? {}
                    : { hint: descriptor.hint }),
            }),
        ),
        overlay: rt.keybindingOverlay,
    });
    installTuiKeymap(resolution.bindings);
    // Said once per distinct set. A reload that changes nothing about the keys must not repeat the banner it already showed.
    for (const notice of resolution.notices) {
        if (rt.announcedKeymapNotices.has(notice)) continue;
        rt.announcedKeymapNotices.add(notice);
        if (rt.transcriptSeeded) {
            rt.state = appendTuiNotice(rt.state, notice);
        } else {
            rt.deferredKeymapNotices.push(notice);
        }
    }
}

export function coreHelpCommands(rt: TuiRuntime): readonly TuiCommandCatalogEntry[] {
    const hostCommandNames = new Set(
        rt.hostExtensionCommands.map((command) => command.name),
    );
    return rt.commandRegistry.registeredCommands().filter(
        (command) => !hostCommandNames.has(command.name),
    );
}

export function registeredPaletteEntries(rt: TuiRuntime): readonly TuiPaletteEntry[] {
    const entries = rt.commandRegistry.registeredPaletteActions();
    if (!isWorkerFreeClient(rt.client)) return entries;
    const viewingFile = isJsonlViewClient(rt.client);
    return [
        ...(viewingFile ? [RESUME_VIEWED_PALETTE_ENTRY] : []),
        ...entries.filter((entry) =>
            workerFreeAction(rt, entry.action, viewingFile)
        ),
    ];
}

export function workerFreeAction(rt: TuiRuntime, 
    action: TuiCommandAction | undefined,
    viewingFile: boolean,
): boolean {
    if (action?.type === "create_session") return viewingFile;
    if (!viewingFile && (action?.type === "open_model_utility" || action?.type === "open_settings_destination")) return true;
    return action?.type === "resume_viewed_session"
        || action?.type === "open_resume_picker"
        || action?.type === "open_help"
        || action?.type === "open_theme_picker"
        || action?.type === "open_usage";
}

export function createMarkdownStyle(rt: TuiRuntime, activeTheme: typeof rt.theme): SyntaxStyle {
    return SyntaxStyle.fromStyles({
    default: { fg: activeTheme.text },
    "markup.heading": { fg: activeTheme.accent, bold: true },
    // Assistant prose uses a quieter base foreground, but emphasis is a deliberate signal and must not inherit that muted color.
    "markup.strong": { fg: activeTheme.text, bold: true },
    "markup.italic": { fg: activeTheme.text, italic: true },
    "markup.raw": { fg: activeTheme.code },
    "markup.raw.block": { fg: activeTheme.code },
    "markup.list": { fg: activeTheme.accent },
    "markup.quote": { fg: activeTheme.muted, italic: true },
    "markup.link": { fg: activeTheme.accent, underline: true },
    "markup.link.label": { fg: activeTheme.accent },
    "markup.link.url": { fg: activeTheme.muted, underline: true },
    comment: { fg: activeTheme.muted, italic: true },
    string: { fg: activeTheme.success },
    number: { fg: activeTheme.notice },
    boolean: { fg: activeTheme.notice },
    keyword: { fg: activeTheme.accent },
    type: { fg: activeTheme.notice },
    "type.builtin": { fg: activeTheme.notice },
    function: { fg: activeTheme.accent },
    "function.call": { fg: activeTheme.accent },
    constant: { fg: activeTheme.notice },
    operator: { fg: activeTheme.muted },
    conceal: { fg: activeTheme.muted },
    });
}

export function clearSidebarEntryNodes(rt: TuiRuntime): void {
    while (rt.sidebarEntryNodes.length > 0) {
        rt.sidebarEntryNodes.pop()?.destroyRecursively();
        rt.sidebarEntryNodeKinds.pop();
    }
}

export function closeSidebarPane(rt: TuiRuntime, extensionId?: string): void {
    const attached = rt.hostedSidebar.release(extensionId);
    if (attached !== undefined) {
        rejectPendingExtensionSettingsFor(rt, 
            attached.client,
            new Error("The sidebar agent closed"),
        );
    }
    rt.pendingSidebarSessionRename = undefined;
    forgetPersistedAgentPane(rt);
    rt.sidebarSessionTitle = undefined;
    void attached?.detach().catch(() => attached.close());
    clearSidebarEntryNodes(rt);
    rt.sidebar.clear();
    rt.sidebar.setHeader(undefined);
    rt.sidebarHeaderVisible = true;
    rt.sidebar.close();
    setSidebarFocused(rt, false);
    rt.composer.focus();
    renderState(rt);
}

export function composerSlotHeight(rt: TuiRuntime): number {
    if (isHomeClient(rt.client)) return 0;
    return isJsonlViewClient(rt.client) && !rt.jsonlCommandMode
        ? rt.resumeOverlay.surface.height
        : rt.composerBox.height;
}

export function setSurfaceBottomInsets(rt: TuiRuntime, rows: number): void {
    rt.workspaceSidebarView.setBottomInset(rows);
    rt.searchOverlayView.setBottomInset(rows);
}

export function setComposerMargin(rt: TuiRuntime, rows: number): void {
    rt.composerMarginRows = rows;
    rt.composerBox.marginBottom = rows;
    rt.resumeOverlay.surface.marginBottom = rows;
    setSurfaceBottomInsets(rt, composerSlotHeight(rt) + rows);
    positionCommandSuggestions(rt);
}

export function positionCommandSuggestions(rt: TuiRuntime): void {
    rt.commandSuggestionsBox.bottom = composerSlotHeight(rt)
        + rt.composerMarginRows
        + rt.experimentalTuiHost.bottomInsetRows()
        + (rt.composerTipText.visible ? 1 : 0)
        + (rt.quoteText.visible ? 1 : 0)
        + (rt.heldAddressText.visible ? 1 : 0)
        + rt.agentNoticeRows
        + 1;
    rt.jumpMenuBox.bottom = rt.commandSuggestionsBox.bottom;
}

export function resizeComposer(rt: TuiRuntime, requestedRows: number): void {
    rt.requestedComposerTextRows = requestedRows;
    const terminalCap = Math.max(
        TUI_COMPOSER_MIN_TEXT_ROWS,
        Math.floor(rt.renderer.height / 4),
    );
    const nextRows = Math.min(
        requestedRows,
        TUI_COMPOSER_MAX_TEXT_ROWS,
        terminalCap,
    );
    if (nextRows === rt.composerTextRows) return;
    rt.composerTextRows = nextRows;
    rt.composer.height = nextRows;
    rt.composerBox.height = tuiComposerPanelRows(nextRows);
    setSurfaceBottomInsets(rt, composerSlotHeight(rt) + rt.composerMarginRows);
    positionCommandSuggestions(rt);
    rt.renderer.requestRender();
}
