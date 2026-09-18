import { defaultHostExtensionConfigs } from "../../../src/extensions/bundled-host.ts";
import { bundledClientExtensionConfigs } from "../../../src/extensions/bundled-client.ts";
import { loadExtensionManifest } from "../../../src/extensions/manifest.ts";
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
    rt.modelSwitcher = undefined;
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
    if (transition.command !== undefined) {
        runExtensionSettings(rt, transition.command);
        return true;
    }
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
        readExtensionEntries(rt),
        loadedExtensionIds(rt),
    );
    rt.extensionsList = withSettingsCommands(rt, rt.extensionsList);
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
        return withSettingsCommands(rt, openTuiExtensionsList(
            readExtensionEntries(rt),
            loadedExtensionIds(rt),
            selected,
        ));
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

function readExtensionEntries(rt: TuiRuntime): readonly ExtensionListEntry[] {
    const entries = [...listExtensions({ projectRoot: process.cwd() })];
    const clientEnabled = new Map<string, boolean>();
    for (const config of rt.configuredClientExtensions) {
        try {
            const { manifest } = loadExtensionManifest(config.path);
            clientEnabled.set(manifest.id, config.enabled);
        } catch {
            // Activation reports invalid configured paths separately.
        }
    }
    const paths = [...defaultHostExtensionConfigs([]), ...bundledClientExtensionConfigs([])];
    for (const config of paths) {
        const { manifest } = loadExtensionManifest(config.path);
        if (entries.some((entry) => entry.id === manifest.id)) continue;
        entries.push({ id: manifest.id, version: manifest.version, scope: "profile", bundled: true,
            enabled: clientEnabled.get(manifest.id)
                ?? !rt.disabledBuiltinExtensions.includes(manifest.id), managed: false,
            path: config.path, source: "Bundled", capabilities: manifest.capabilities });
    }
    return entries;
}

function withSettingsCommands(rt: TuiRuntime, state: TuiExtensionsListState): TuiExtensionsListState {
    const commands = rt.clientExtensionRegistry?.commands() ?? [];
    return { ...state, rows: state.rows.map((row) => ({ ...row,
        settingsCommands: row.loaded && row.status !== "shadowed" ? commands
            .filter((command) => command.source === row.id && command.palette?.group === "Settings" && (command.isAvailable?.() ?? true))
            .map((command) => ({ name: command.name, label: command.palette!.label })) : [],
    })) };
}

function runExtensionSettings(rt: TuiRuntime, command: string): void {
    const previous = rt.extensionsList;
    if (!previous || rt.extensionCommandPending || !rt.clientExtensionRegistry) return;
    rt.extensionsList = undefined;
    rt.extensionCommandPending = true;
    renderState(rt);
    void rt.clientExtensionRegistry.invokeCommand(command, "", rt.client.workspace ?? process.cwd())
        .catch((error) => {
            if (!rt.shuttingDown) rt.state = appendTuiError(rt.state, error instanceof Error ? error.message : "Extension settings failed.");
        }).finally(() => {
            rt.extensionCommandPending = false;
            if (rt.shuttingDown) return;
            const selected = previous.rows[previous.selectedIndex];
            rt.extensionsList = { ...loadExtensionsList(rt, selected), screen: "detail" };
            renderState(rt);
            focusActiveSurface(rt);
        });
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
