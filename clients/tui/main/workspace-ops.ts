import type { SessionSearchQuery } from "../../../src/store/session-search.ts";
import { tuiComposerOverlayInset } from "../appearance.ts";
import { startTuiCommandPalette } from "../command-palette.ts";
import { startTuiHelp } from "../help.ts";
import { isWorkerFreeClient } from "../jsonl-view-client.ts";
import { buildJumpRows, openJumpMenu as openJumpMenuState, type JumpOrigin } from "../jump.ts";
import { beginCreateSession, beginSessionResume } from "../main.ts";
import { focusedAgentClient } from "../main/agents-dials.ts";
import { clearSearchLanding, coreHelpCommands, registeredPaletteEntries, setComposerMargin } from "../main/chrome.ts";
import { focusActiveSurface } from "../main/focus-switch.ts";
import { renderJumpMenu } from "../main/palette-jump.ts";
import { anyOverlayOpen, renderState } from "../main/render-state.ts";
import { captureTranscriptScrollAnchor, transcriptFollowsBottom } from "../main/transcript-nodes.ts";
import { startTuiNamePrompt, type TuiNamePromptTarget } from "../name-prompt.ts";
import { applySearchFailure, applySearchResults, startSearchOverlay, type SearchScope } from "../search-overlay.ts";
import { startTuiSessionPicker, type TuiSettingsPickerState } from "../settings-picker.ts";
import { appendTuiError, appendTuiNotice } from "../state.ts";
import { saveTuiPinnedSessionIds, saveTuiWorkspaceSidebarDocked } from "../theme-preference.ts";
import { startWorkTab, type WorkTabState } from "../work-tab.ts";
import { applyWorkspaceWorkIndex, clampWorkspaceRailColumns, openWorkspaceSelection, refreshWorkspaceSidebarSessions, startWorkspaceSidebar, workspaceCycleTarget, workspaceRailColumns, workspaceSidebarSessions, type WorkspaceSidebarAction, type WorkspaceSidebarState } from "../workspace-sidebar.ts";
import type { TuiRuntime } from "./runtime.ts";

export function openJumpMenuOverlay(rt: TuiRuntime): void {
    if (rt.jumpMenu !== undefined || anyOverlayOpen(rt)) return;
    if (rt.dependencies.listAgents === undefined) {
        rt.state = appendTuiNotice(
            rt.state,
            "Jumping between conversations is unavailable on this host",
        );
        renderState(rt);
        return;
    }
    void rt.dependencies.listAgents().then((agents) => {
        if (rt.shuttingDown || anyOverlayOpen(rt)) return;
        const currentId = rt.client.agentId;
        const originAgent = agents.find((agent) =>
            agent.id === rt.backOriginId
        );
        const back: JumpOrigin | undefined = originAgent === undefined
            ? undefined
            : {
                sessionId: originAgent.id,
                sessionPath: originAgent.session_path,
                title: originAgent.title ?? originAgent.name
                    ?? "previous conversation",
            };
        const needsYou = (rt.workIndex?.rows ?? []).filter((row) =>
            row.section === "needs_you"
        );
        rt.jumpMenu = openJumpMenuState(buildJumpRows({
            currentId,
            back,
            needsYou,
            agents,
        }));
        if (rt.jumpMenu === undefined) {
            rt.state = appendTuiNotice(
                rt.state,
                "Nowhere to jump: nothing needs you and this conversation"
                    + " has no parent or children",
            );
            renderState(rt);
            return;
        }
        renderJumpMenu(rt);
    }).catch((error) => {
        if (rt.shuttingDown) return;
        rt.state = appendTuiError(
            rt.state,
            `Could not build the jump menu: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        renderState(rt);
    });
}

export function openWorkTab(rt: TuiRuntime): void {
    if (rt.workIndex === undefined) {
        rt.state = appendTuiError(
            rt.state,
            "This host does not report work; reconnect to see the inbox",
        );
        renderState(rt);
        rt.composer.focus();
        return;
    }
    rt.workTab = startWorkTab(rt.workIndex);
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

export function focusWorkspaceSidebar(rt: TuiRuntime): void {
    if (rt.workspaceSidebar === undefined || rt.workspaceSidebarFocused) return;
    rt.workspaceSidebarFocused = true;
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

export function openWorkspaceSidebar(rt: TuiRuntime, 
    options: { readonly focus?: boolean; readonly persist?: boolean } = {},
): void {
    if (rt.dependencies.listAgents === undefined) {
        rt.state = appendTuiError(
            rt.state,
            "This host does not list sessions; reconnect to switch",
        );
        renderState(rt);
        rt.composer.focus();
        return;
    }
    const generation = rt.clientGeneration;
    const focus = options.focus !== false;
    if (options.persist !== false) {
        rt.workspaceSidebarDocked = true;
        try {
            saveTuiWorkspaceSidebarDocked(true);
        } catch {
            // A preference write cannot stop the rail opening now.
        }
    }
    void rt.dependencies.listAgents().then((agents) => {
        if (rt.shuttingDown || generation !== rt.clientGeneration) return;
        const sessions = workspaceSidebarSessions(agents);
        const opened = startWorkspaceSidebar(
            sessions,
            rt.workspacePinnedIds,
            rt.client.agentId,
        );
        rt.workspaceSidebar = rt.workIndex === undefined
            ? opened
            : applyWorkspaceWorkIndex(opened, rt.workIndex);
        rt.workspaceSidebarFocused = focus;
        if (focus) rt.composer.blur();
        renderState(rt);
        focusActiveSurface(rt);
    }).catch((error) => {
        if (rt.shuttingDown) return;
        rt.state = appendTuiError(
            rt.state,
            `Could not list sessions: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        renderState(rt);
    });
}

export function cycleLiveSession(rt: TuiRuntime, direction: 1 | -1): void {
    const openFrom = (listed: WorkspaceSidebarState): void => {
        const target = workspaceCycleTarget(
            listed,
            direction,
            new Date(),
            rt.renderer.width,
        );
        if (target === undefined) return;
        const action = openWorkspaceSelection(listed, target.id);
        if (action !== undefined) {
            runWorkspaceSidebarAction(rt, action, false);
        }
    };
    if (rt.workspaceSidebar !== undefined) {
        openFrom(rt.workspaceSidebar);
        return;
    }
    if (rt.dependencies.listAgents === undefined) {
        rt.state = appendTuiError(
            rt.state,
            "This host does not list sessions; reconnect to switch",
        );
        renderState(rt);
        return;
    }
    const generation = rt.clientGeneration;
    void rt.dependencies.listAgents().then((agents) => {
        if (rt.shuttingDown || generation !== rt.clientGeneration) return;
        const sessions = workspaceSidebarSessions(agents);
        const opened = startWorkspaceSidebar(
            sessions,
            rt.workspacePinnedIds,
            rt.client.agentId,
        );
        openFrom(
            rt.workIndex === undefined
                ? opened
                : applyWorkspaceWorkIndex(opened, rt.workIndex),
        );
    }).catch((error) => {
        if (rt.shuttingDown) return;
        rt.state = appendTuiError(
            rt.state,
            `Could not list sessions: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        renderState(rt);
    });
}

export function refreshWorkspaceSidebarRoster(rt: TuiRuntime): void {
    if (rt.dependencies.listAgents === undefined) return;
    const generation = rt.clientGeneration;
    void rt.dependencies.listAgents().then((agents) => {
        if (rt.shuttingDown || generation !== rt.clientGeneration) return;
        const open = rt.workspaceSidebar;
        if (open === undefined) return;
        const listed = refreshWorkspaceSidebarSessions(
            open,
            workspaceSidebarSessions(agents),
        );
        rt.workspaceSidebar = rt.workIndex === undefined
            ? listed
            : applyWorkspaceWorkIndex(listed, rt.workIndex);
        renderState(rt);
    }).catch(() => {
        // Nothing to say: the rows already listed are still the best
        // answer, and the next push asks again.
    });
}

export function applyWorkspaceRail(rt: TuiRuntime): void {
    const columns = rt.workspaceSidebar === undefined
        ? undefined
        : workspaceRailColumns(rt.renderer.width, rt.workspaceRailPreferred);
    if (columns !== rt.workspaceRail) {
        rt.workspaceRail = columns;
        if (transcriptFollowsBottom(rt)) {
            rt.pendingTranscriptScrollRestore = { scrollTop: 0, atBottom: true };
        } else {
            captureTranscriptScrollAnchor(rt);
        }
        rt.workspaceSidebarView.setRail(columns);
    }
    const occupied = rt.workspaceSidebarView.railColumns() ?? 0;
    // Everything below is a function of the width the rail occupies and
    // the width of the terminal, and re-applying it repaints. Timed
    // refreshes call this on every tick, so the layout is only laid out
    // again when one of the two has moved.
    if (
        occupied === rt.workspaceRailLaidOut
        && rt.renderer.width === rt.workspaceRailLaidOutColumns
    ) return;
    rt.workspaceRailLaidOut = occupied;
    rt.workspaceRailLaidOutColumns = rt.renderer.width;
    // The navigator owns a full-height column like an editor sidebar.
    // Reserving that width on the app moves the transcript, composer,
    // status rows and dialogs together; nothing from the chat can run
    // underneath the dock.
    rt.app.paddingLeft = occupied;
    rt.workspaceSidebarView.surface.left = 0;
    // Global dialogs still hide the rail. Session-owned approval and
    // question cards stay in the chat column; renderState narrows their
    // scrim to that column after it knows which kind of overlay is open.
    rt.overlayScrim.left = 0;
    rt.overlayScrim.width = rt.renderer.width;
    rt.statusBand.left = occupied;
    rt.statusBand.width = Math.max(0, rt.renderer.width - occupied);
    // The card centres itself inside its surface, so the surface has to be
    // the space the rail leaves rather than the whole terminal.
    rt.homeView.surface.left = occupied;
    rt.homeView.surface.width = Math.max(1, rt.renderer.width - occupied);
    // The idle block breaks its prose to the chat's width, and its
    // height is part of what the composer slot occupies, so a change in
    // one has to reach the rows measured off the other.
    if (
        rt.resumeOverlay.setColumns(Math.max(1, rt.renderer.width - occupied))
    ) {
        setComposerMargin(rt, rt.composerMarginRows);
    }
    rt.commandSuggestionsBox.left = occupied;
    rt.jumpMenuBox.left = occupied
        + tuiComposerOverlayInset(rt.appearance).paddingLeft;
    rt.sidebar.body.paddingLeft = 0;
    rt.sidebar.refit();
}

export function resizeWorkspaceRailAt(rt: TuiRuntime, pointerColumn: number): void {
    if (rt.workspaceRail === undefined) return;
    const occupied = rt.workspaceSidebarView.railColumns();
    if (occupied === undefined) return;
    const inset = occupied - rt.workspaceRail;
    const next = clampWorkspaceRailColumns(
        pointerColumn + 1 - inset,
        rt.renderer.width,
    );
    if (next === undefined || next === rt.workspaceRail) return;
    rt.workspaceRailPreferred = next;
    renderState(rt);
}

export function closeWorkspaceSidebar(rt: TuiRuntime): void {
    rt.workspaceSidebar = undefined;
    rt.workspaceSidebarFocused = false;
    rt.workspaceSidebarDocked = false;
    rt.workspaceRailDragging = false;
    rt.workspaceSidebarView.box.borderColor = rt.theme.element;
    try {
        saveTuiWorkspaceSidebarDocked(false);
    } catch {
        // The current layout still closes when persistence cannot update.
    }
    rt.workspaceSidebarView.surface.visible = false;
    rt.composer.focus();
    renderState(rt);
    focusActiveSurface(rt);
}

export function runWorkspaceSidebarAction(rt: TuiRuntime, 
    action: WorkspaceSidebarAction,
    armsBack = true,
): void {
    if (action.kind === "close") {
        rt.workspaceSidebarFocused = false;
        rt.composer.focus();
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    if (action.kind === "hide") {
        closeWorkspaceSidebar(rt);
        return;
    }
    if (action.kind === "pin") {
        rt.workspacePinnedIds = action.pinnedIds;
        try {
            saveTuiPinnedSessionIds(action.pinnedIds);
        } catch {
            // A preference write cannot stop the list from reordering.
        }
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    if (action.kind === "new_session") {
        rt.workspaceSidebarFocused = false;
        rt.composer.focus();
        renderState(rt);
        beginCreateSession(rt, "keep_running");
        return;
    }
    if (action.kind === "resume_picker") {
        rt.workspaceSidebarFocused = false;
        openResumePicker(rt);
        return;
    }
    if (action.kind === "rename_session") {
        openNamePrompt(rt, 
            { kind: "session", sessionId: action.session_id },
            action.label,
            undefined,
            action.value,
        );
        return;
    }
    rt.workspaceSidebarFocused = false;
    rt.composer.focus();
    renderState(rt);
    // The rail is working-set chrome. Opening another row must not stop
    // live work on the session you left; `/resume` Enter still does.
    // Idle rows paint the file. A row that already has a worker attaches.
    beginSessionResume(rt, 
        action.session_path,
        action.session_id,
        false,
        armsBack,
        "keep_running",
        action.active ? "attach" : "jsonl",
    );
}

export function openResumePicker(rt: TuiRuntime): void {
    if (rt.dependencies.listAgents === undefined) {
        rt.state = appendTuiError(rt.state, "Session listing is unavailable");
        renderState(rt);
        return;
    }
    const version = ++rt.resumeListVersion;
    const targetAgentId = focusedAgentClient(rt).agentId;
    // Neither home nor a session file has a worker to stop, so Enter is
    // not a switch away from anything: it opens the row and that is all.
    const nothingToLeave = isWorkerFreeClient(rt.client);
    rt.settingsPicker = startTuiSessionPicker(
        [],
        targetAgentId,
        true,
        new Date(),
        false,
        [],
        "stop",
        nothingToLeave,
    );
    focusActiveSurface(rt);
    renderState(rt);
    void rt.dependencies.listAgents().then((agents) => {
        if (
            rt.shuttingDown
            || version !== rt.resumeListVersion
            || rt.settingsPicker?.kind !== "session"
        ) {
            return;
        }
        rt.settingsPicker = startTuiSessionPicker(
            agents,
            targetAgentId,
            false,
            new Date(),
            false,
            rt.hostedPanePersistence.groups,
            "stop",
            nothingToLeave,
        );
        focusActiveSurface(rt);
        renderState(rt);
    }).catch((error) => {
        if (
            !rt.shuttingDown
            && version === rt.resumeListVersion
            && rt.settingsPicker?.kind === "session"
        ) {
            const message = error instanceof Error
                ? error.message
                : String(error);
            rt.state = appendTuiError(
                rt.state,
                `Could not list sessions: ${message}`,
            );
            rt.settingsPicker = undefined;
            focusActiveSurface(rt);
            renderState(rt);
        }
    });
}

export function closeWorkSurfaces(rt: TuiRuntime): void {
    rt.workTab = undefined;
    rt.searchOverlay = undefined;
    // The scan already running finishes and finds no overlay to fill; the
    // one waiting behind it never starts.
    rt.queuedSearch = undefined;
    rt.workTabView.surface.visible = false;
    rt.searchOverlayView.surface.visible = false;
    rt.composer.focus();
    renderState(rt);
    focusActiveSurface(rt);
}

export function runWorkTabAction(rt: TuiRuntime, 
    open: WorkTabState,
    action:
        | { readonly kind: "close" }
        | {
            readonly kind:
                | "answer_request"
                | "open_session"
                | "open_result";
            readonly session_id: string;
        },
): void {
    if (action.kind === "close") {
        closeWorkSurfaces(rt);
        return;
    }
    const row = open.index.rows.find(
        (candidate) => candidate.session_id === action.session_id,
    );
    closeWorkSurfaces(rt);
    if (row !== undefined) {
        beginSessionResume(rt, row.session_path, row.session_id);
    }
}

export function runSearchOverlayAction(rt: TuiRuntime, 
    action:
        | { readonly kind: "close" }
        | {
            readonly kind: "search";
            readonly query: SessionSearchQuery;
        }
        | {
            readonly kind: "open";
            readonly session_id: string;
            readonly session_path: string;
            readonly entry_id: string | null;
        },
): void {
    if (action.kind === "close") {
        closeWorkSurfaces(rt);
        return;
    }
    if (action.kind === "open") {
        closeWorkSurfaces(rt);
        // Set before the switch, so the first paint of the session that
        // arrives is the one that scrolls.
        rt.pendingSearchTarget = action.entry_id === null
            ? undefined
            : { sessionId: action.session_id, entryId: action.entry_id };
        beginSessionResume(rt, action.session_path, action.session_id);
        return;
    }
    renderState(rt);
    focusActiveSurface(rt);
    if (rt.dependencies.searchSessions === undefined) {
        rt.searchOverlay = rt.searchOverlay === undefined
            ? undefined
            : applySearchFailure(
                rt.searchOverlay,
                action.query,
                "Searching past work is unavailable on this host",
            );
        renderState(rt);
        return;
    }
    beginSearch(rt, action.query);
}

export function beginSearch(rt: TuiRuntime, query: SessionSearchQuery): void {
    if (rt.searchInFlight) {
        rt.queuedSearch = query;
        return;
    }
    rt.searchInFlight = true;
    const finish = (): void => {
        rt.searchInFlight = false;
        const next = rt.queuedSearch;
        rt.queuedSearch = undefined;
        if (next !== undefined && !rt.shuttingDown
            && rt.searchOverlay !== undefined) {
            beginSearch(rt, next);
        }
    };
    void rt.dependencies.searchSessions!(query).then((results) => {
        if (!rt.shuttingDown && rt.searchOverlay !== undefined) {
            rt.searchOverlay = applySearchResults(
                rt.searchOverlay,
                query,
                results,
            );
            renderState(rt);
        }
    }, (error) => {
        if (!rt.shuttingDown && rt.searchOverlay !== undefined) {
            rt.searchOverlay = applySearchFailure(
                rt.searchOverlay,
                query,
                error instanceof Error ? error.message : String(error),
            );
            renderState(rt);
        }
    }).finally(finish);
}

export function openNamePrompt(rt: TuiRuntime, 
    target: TuiNamePromptTarget,
    label: string,
    parent: TuiSettingsPickerState | undefined,
    value?: string,
): void {
    rt.namePrompt = startTuiNamePrompt(target, label, parent, value);
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

export function openSearchOverlay(rt: TuiRuntime, scope?: SearchScope): void {
    // The previous landing answered the previous question. Clearing it on
    // open, not on close, keeps the mark visible for as long as the reader
    // is still looking at what the last search found.
    clearSearchLanding(rt);
    const target = focusedAgentClient(rt);
    rt.searchOverlay = startSearchOverlay(target.workspace ?? process.cwd(), {
        ...(target.agentId === undefined
            ? {}
            : { sessionId: target.agentId }),
        ...(scope === undefined ? {} : { scope }),
    });
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

export function openCommandPalette(rt: TuiRuntime): void {
    rt.commandPalette = startTuiCommandPalette(registeredPaletteEntries(rt));
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

export function openHelp(rt: TuiRuntime, tab: "general" | "keys" = "general"): void {
    const nextHelp = startTuiHelp(coreHelpCommands(rt), rt.hostExtensionCommands);
    rt.help = tab === "general" ? nextHelp : { ...nextHelp, tab };
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}
