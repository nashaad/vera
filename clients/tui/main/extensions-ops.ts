import {
    listExtensions,
    removeExtension,
    setExtensionEnabled,
    type ExtensionListEntry,
} from "../../../src/extensions/manager.ts";
import { renderExtensionMutation } from "../../../src/extensions/manager-command.ts";
import {
    clientExtensionReloadFailed,
    clientExtensionReloadStarted,
    clientExtensionReloadSucceeded,
    reloadTuiClientExtensions,
} from "../client-extension-reload.ts";
import {
    handleTuiExtensionsListKey,
    openTuiExtensionsList,
    openTuiExtensionsListError,
    syncTuiExtensionsList,
    type TuiExtensionListRow,
    type TuiExtensionsListKey,
    type TuiExtensionsListState,
} from "../extensions-list.ts";
import { appendTuiError, appendTuiNotice, appendTuiNoticeCard, tuiNoticeCardLines } from "../state.ts";
import { focusActiveSurface } from "./focus-switch.ts";
import { renderState } from "./render-state.ts";
import type { TuiRuntime } from "./runtime.ts";

const EXTENSION_NOTICE_KEY = "extensions";

const HOST_RESTART_NOTICE =
    "Client extensions reload now; restart the resident host for host-side capabilities.";

export function openExtensionsList(rt: TuiRuntime): void {
    rt.extensionsDialog = undefined;
    rt.documentDialog = undefined;
    rt.diagnosticsDialog = undefined;
    rt.doctorDialog = undefined;
    rt.commandPalette = undefined;
    rt.help = undefined;
    rt.extensionsList = loadExtensionsList(rt);
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

export function applyExtensionsListKey(
    rt: TuiRuntime,
    key: TuiExtensionsListKey,
): boolean {
    if (rt.extensionsList === undefined) return false;
    const transition = handleTuiExtensionsListKey(rt.extensionsList, key);
    if (!transition.handled) return false;
    if (transition.mutate !== undefined) {
        applyExtensionsListMutation(rt, transition.mutate.operation, transition.mutate.entry);
        return true;
    }
    rt.extensionsList = transition.state;
    if (rt.extensionsList === undefined) {
        rt.extensionsListView.box.visible = false;
        rt.composer.focus();
    }
    renderState(rt);
    if (rt.extensionsList !== undefined) focusActiveSurface(rt);
    return true;
}

export function refreshOpenExtensionsList(rt: TuiRuntime): void {
    if (rt.extensionsList === undefined) return;
    const selected = rt.extensionsList.rows[rt.extensionsList.selectedIndex];
    rt.extensionsList = syncTuiExtensionsList(
        rt.extensionsList,
        readExtensionEntries(),
        loadedExtensionIds(rt),
    );
    if (
        selected !== undefined
        && rt.extensionsList.rows[rt.extensionsList.selectedIndex]?.id !== selected.id
    ) {
        rt.extensionsList = {
            ...rt.extensionsList,
            selectedIndex: selectedIndexOf(rt.extensionsList, selected),
        };
    }
}

function loadExtensionsList(
    rt: TuiRuntime,
    selected?: { readonly scope: "profile" | "project"; readonly id: string },
): TuiExtensionsListState {
    try {
        return openTuiExtensionsList(
            readExtensionEntries(),
            loadedExtensionIds(rt),
            selected,
        );
    } catch (error) {
        return openTuiExtensionsListError(
            error instanceof Error ? error.message : String(error),
        );
    }
}

function applyExtensionsListMutation(
    rt: TuiRuntime,
    operation: "enable" | "disable" | "remove",
    entry: TuiExtensionListRow,
): void {
    try {
        const target = entry.scope === "project"
            ? { scope: "project" as const, projectRoot: process.cwd() }
            : { scope: "profile" as const };
        const record = operation === "remove"
            ? removeExtension(entry.id, target)
            : setExtensionEnabled(entry.id, operation === "enable", target);
        const line = renderExtensionMutation(operation, record, entry.scope)
            .trimEnd();
        const changes = [
            ...tuiNoticeCardLines(
                rt.state,
                EXTENSION_NOTICE_KEY,
                HOST_RESTART_NOTICE,
            ),
            line,
        ];
        rt.state = appendTuiNoticeCard(
            rt.state,
            [...changes, HOST_RESTART_NOTICE].join("\n"),
            changes.length === 1
                ? line
                : `${changes.length} extension changes`,
            EXTENSION_NOTICE_KEY,
        );
        const previousScreen = rt.extensionsList?.screen;
        const selected = operation === "remove" ? undefined : {
            scope: entry.scope,
            id: entry.id,
        };
        rt.extensionsList = loadExtensionsList(rt, selected);
        if (operation !== "remove" && previousScreen === "detail") {
            rt.extensionsList = {
                ...rt.extensionsList,
                screen: "detail",
                actionIndex: 0,
            };
        }
        reloadClientExtensionsForList(rt);
        renderState(rt);
        focusActiveSurface(rt);
    } catch (error) {
        rt.state = appendTuiError(
            rt.state,
            `Extension operation failed: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        renderState(rt);
        focusActiveSurface(rt);
    }
}

function reloadClientExtensionsForList(rt: TuiRuntime): void {
    if (rt.clientExtensionReloadPending) return;
    rt.clientExtensionReloadPending = true;
    rt.clientExtensionReload = clientExtensionReloadStarted();
    void reloadTuiClientExtensions({
        configuration: {
            disabledBuiltinExtensions: rt.disabledBuiltinExtensions,
            clientExtensions: rt.configuredClientExtensions,
        },
        refreshConfiguration: rt.dependencies.loadClientExtensionConfiguration,
        applyConfiguration(configuration) {
            rt.disabledBuiltinExtensions = configuration.disabledBuiltinExtensions;
            rt.configuredClientExtensions = configuration.clientExtensions;
        },
        host: rt.clientExtensionHost,
        start(signal, extensions, failures) {
            return rt.startConfiguredClientExtensionHost(
                signal,
                extensions,
                failures,
            );
        },
    }).then((loadedIds) => {
        if (rt.shuttingDown) return;
        rt.clientExtensionReload = clientExtensionReloadSucceeded(loadedIds);
        refreshOpenExtensionsList(rt);
        renderState(rt);
        if (rt.extensionsList !== undefined) focusActiveSurface(rt);
    }).catch((error) => {
        if (rt.shuttingDown) return;
        const outcome = clientExtensionReloadFailed(
            error,
            rt.clientExtensionHost.current()?.loadedExtensionIds() ?? [],
        );
        rt.clientExtensionReload = outcome.snapshot;
        rt.state = appendTuiNotice(rt.state, outcome.notice);
        refreshOpenExtensionsList(rt);
        renderState(rt);
        if (rt.extensionsList !== undefined) focusActiveSurface(rt);
    }).finally(() => {
        rt.clientExtensionReloadPending = false;
    });
}

function readExtensionEntries(): readonly ExtensionListEntry[] {
    return listExtensions({ projectRoot: process.cwd() });
}

function loadedExtensionIds(rt: TuiRuntime): ReadonlySet<string> {
    return new Set(rt.clientExtensionHost.current()?.loadedExtensionIds() ?? []);
}

function selectedIndexOf(
    state: TuiExtensionsListState,
    selected: TuiExtensionListRow,
): number {
    const index = state.rows.findIndex((row) =>
        row.scope === selected.scope && row.id === selected.id
    );
    return index === -1 ? state.selectedIndex : index;
}
