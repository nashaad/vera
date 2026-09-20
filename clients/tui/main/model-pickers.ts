import { isRefreshableProvider } from "../../../src/model/refreshable-providers.ts";
import { providerCatalogsOf } from "../../../src/host/model-catalog-settings.ts";
import { connectedProviderCatalogs } from "../../../src/providers/catalog-state.ts";
import { createAuthStorage } from "../../../src/providers/auth-storage.ts";
import { readProviderCatalogSnapshot } from "../../../src/model/catalog-cache.ts";
import { modelBrowse } from "../model-browse.ts";
import { updateTuiSettingsPickerSearch } from "../settings-picker.ts";
import { configuredModelAssignments, startingVeraConfig, loadOptionalVeraConfig, updateVeraConfigDefaults, type VeraProviderId } from "../../../src/config.ts";
import type { ModelAssignmentId, ModelAssignmentRow } from "../../../src/config/model-assignments.ts";
import { derivedModelName } from "../../../src/config/model-catalog.ts";
import type { ModelSettingsPatch } from "../../../src/engine/model-settings.ts";
import { poolReachability } from "../../../src/model/assignment-reachability.ts";
import { eligibleForDefault } from "../../../src/model/model-operations.ts";
import type { ReasoningLevel, ReasoningLevelId } from "../../../src/model/catalog-shape.ts";
import { levelsForModel } from "../../../src/model/catalog-view.ts";
import { loadPoolFile } from "../../../src/model/pool-file-loader.ts";
import type { ModelReasoningEffort } from "../../../src/model/types.ts";
import { openGate, providerAnswerLabel, type OnboardingInput } from "../../../src/providers/onboarding.ts";
import { configuredProviders, findConfiguredProvider, isProviderConnected, type ProviderDescriptor } from "../../../src/providers/registry.ts";
import { openFileInEditor, veraConfigPath } from "../../editor.ts";
import { isHomeClient } from "../home-client.ts";
import { closeSettingsPickerSurface, defaultLoginProvider, requestCatalogRefresh } from "../main.ts";
import { focusedAgentClient, focusedAgentState } from "../main/agents-dials.ts";
import { adoptStandingNudgesState } from "../main/chrome.ts";
import { requestAgentSettings } from "../main/diagnostics-ops.ts";
import { sendCommand } from "../main/extension-bridge.ts";
import { focusActiveSurface } from "../main/focus-switch.ts";
import { refreshLocalRuntimeStatus } from "../main/outrider-control.ts";
import { renderState } from "../main/render-state.ts";
import { renderSidebarAgent } from "../main/sidebar-pane.ts";
import { renderPermissionInspection } from "../permission-inspection.ts";
import { startTuiPreferencesList } from "../preferences-list.ts";
import { startTuiSecretPrompt } from "../secret-prompt.ts";
import { startTuiConfigurePicker, startTuiModelAssignmentPicker, startTuiProviderForm, startTuiProviderPicker, startTuiReasoningPicker, startTuiReviewerMenu, startTuiReviewerPicker, startTuiSettingsPicker, switchedModelTab, tuiModelActionOptions, tuiModelAssignmentOptions, tuiProviderGroup, withTuiPickerParent, type TuiConfigureFile, type TuiReviewerSlot, type TuiProviderRow, type TuiSettingsPickerOption, type TuiSettingsPickerState } from "../settings-picker.ts";
import { openTuiStandingNudges } from "../standing-nudges.ts";
import { appendTuiError, appendTuiNotice, type TuiState } from "../state.ts";
import { tuiThemePreferencePath, loadModelPickerPreferences } from "../theme-preference.ts";
import type { TuiRuntime } from "./runtime.ts";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function openReviewerMenu(rt: TuiRuntime, parent?: TuiSettingsPickerState): void {
    rt.settingsPicker = withTuiPickerParent(
        startTuiReviewerMenu(rt.state.modelSettings?.reviewerDefault),
        parent,
    );
    renderState(rt);
    focusActiveSurface(rt);
}

export function openReviewerPicker(rt: TuiRuntime, 
    slot: TuiReviewerSlot,
    parent?: TuiSettingsPickerState,
): void {
    const reviewer = rt.state.modelSettings?.reviewerDefault;
    rt.settingsPicker = withTuiPickerParent(
        startTuiReviewerPicker(
            slot,
            rt.state.modelSettings?.pooled,
            slot === "primary" ? reviewer?.primary : reviewer?.fallback,
            rt.state.modelSettings?.availableModels,
        ),
        parent,
    );
    renderState(rt);
    focusActiveSurface(rt);
}

export function reviewerPatchFor(rt: TuiRuntime, 
    selection: { slot: TuiReviewerSlot; provider?: string; model?: string },
): ModelSettingsPatch["reviewer"] {
    const chosen = selection.model === undefined ? undefined : {
        model: selection.model,
        ...(selection.provider === undefined
            ? {}
            : { provider: selection.provider }),
    };
    const current = rt.state.modelSettings?.reviewerDefault;
    if (selection.slot === "primary") {
        if (chosen === undefined) return null;
        return {
            primary: chosen,
            ...(current?.fallback === undefined
                ? {}
                : { fallback: current.fallback }),
        };
    }
    if (current?.mode !== "fixed" || current.primary === undefined) {
        return undefined;
    }
    return { primary: current.primary, fallback: chosen ?? null };
}

export function reviewerToast(rt: TuiRuntime, 
    selection: { slot: TuiReviewerSlot; provider?: string; model?: string },
): string {
    const name = selection.model === undefined
        ? "configured default"
        : selection.model;
    return selection.slot === "primary" ? name : `failsafe ${name}`;
}

export function openModelPicker(rt: TuiRuntime, parent?: TuiSettingsPickerState): void {
    if (parent === undefined) rt.settingsPickerAgent = focusedAgentClient(rt);
    const targetState = focusedAgentState(rt);
    const currentProvider = targetState.modelSettings?.provider;
    const currentModel = targetState.modelSettings?.model;
    const pooled = targetState.modelSettings?.pooled ?? [];
    const currentShortlisted = currentProvider !== undefined
        && currentModel !== undefined
        && pooled.some((entry) =>
            entry.provider === currentProvider
            && entry.model === currentModel
        );
    rt.settingsPicker = withTuiPickerParent(startTuiSettingsPicker(
        "model",
        targetState.modelSettings?.model,
        targetState.modelSettings?.reasoningEffort,
        targetState.approvalMode,
        targetState.modelSettings?.availableModels,
        undefined,
        targetState.modelSettings?.provider,
        undefined,
        pooled,
    ), parent);
    rt.settingsPicker = {
        ...rt.settingsPicker,
        ...modelRequestOptionsFacts(rt),
        assignmentOptions: tuiModelAssignmentOptions(
            currentModelAssignmentRows(rt),
            targetState.modelSettings?.model,
            targetState.modelSettings?.reasoningEffort,
            targetState.modelSettings?.contextLimit,
        ),
        actionOptions: modelPickerActionOptions(rt, targetState.modelSettings),
        ...(targetState.modelSettings?.webdevArenaSnapshot === undefined
            ? {}
            : {
                webdevArenaSnapshot:
                    targetState.modelSettings.webdevArenaSnapshot,
            }),
        providerCatalogs: providerCatalogsOf(targetState.modelSettings),
        modelCatalogUnavailable: targetState.modelSettings === undefined
            && isHomeClient(focusedAgentClient(rt)),
    };
    if (rt.settingsPicker.tab === "pool" && currentShortlisted === false) {
        rt.settingsPicker = {
            ...switchedModelTab(rt.settingsPicker, "pool"),
            selectedIndex: 0,
        };
    }
    const preferences = loadModelPickerPreferences();
    rt.settingsPicker = modelBrowse({ ...rt.settingsPicker, tab: preferences.scope,
        browseView: preferences.view, browseSort: preferences.sort }, "browse");
    requestAgentSettings(rt, focusedAgentClient(rt));
    renderState(rt);
    focusActiveSurface(rt);
}

export function modelRequestOptionsFacts(rt: TuiRuntime): Pick<
    TuiSettingsPickerState,
    "requestOptionsProviders" | "configuredRequestOptions"
> {
    const config = loadOptionalVeraConfig();
    const requestOptionsProviders = Object.fromEntries(
        configuredProviders(config).flatMap((provider) =>
            provider.requestOptions === undefined
                ? []
                : [[provider.id, {
                    providerLabel: provider.label,
                    label: provider.requestOptions.label,
                    explanation: provider.requestOptions.explanation,
                    documentationUrl: provider.requestOptions.documentationUrl,
                }]]
        ),
    );
    return {
        requestOptionsProviders,
        configuredRequestOptions: Object.keys(
            config?.model_request_options ?? {},
        ),
    };
}

export function modelPickerActionOptions(rt: TuiRuntime, 
    settings: TuiState["modelSettings"],
): readonly TuiSettingsPickerOption[] {
    const provider = settings?.provider;
    const model = settings?.model;
    const pooled = settings?.pooled ?? [];
    return tuiModelActionOptions(
        refreshableProvidersOf(rt, 
            settings?.availableModels,
            settings?.refreshableProviders,
        ),
        {
            hasPool: pooled.length > 0,
            ...(provider === undefined || model === undefined
                ? {}
                : {
                    currentModel: {
                        provider,
                        model,
                        shortlisted: isModelShortlisted(rt, 
                            settings,
                            provider,
                            model,
                        ),
                    },
                }),
        },
    );
}

export function isModelShortlisted(rt: TuiRuntime, 
    settings: TuiState["modelSettings"],
    provider: string,
    model: string,
): boolean {
    return settings?.pooled?.some((entry) =>
        entry.provider === provider && entry.model === model
    ) === true;
}

export function refreshableProvidersOf(rt: TuiRuntime, 
    models: readonly {
        readonly provider: string;
        readonly refreshable?: boolean;
    }[] | undefined,
    providers: readonly string[] | undefined,
): readonly string[] {
    if (providers !== undefined) return [...new Set(providers)];
    const named = new Set<string>();
    for (const model of models ?? []) {
        if (model.refreshable === true) {
            named.add(model.provider);
        }
    }
    return [...named].toSorted();
}

export function catalogSizeOf(rt: TuiRuntime, provider: string): number {
    return (rt.state.modelSettings?.availableModels ?? [])
        .filter((entry) => entry.provider === provider)
        .length;
}

export function currentModelAssignmentRows(rt: TuiRuntime): readonly ModelAssignmentRow[] {
    const configured = loadOptionalVeraConfig() ?? startingVeraConfig();
    return configuredModelAssignments(
        configured,
        poolReachability(loadPoolFile({ projectRoot: process.cwd() }).merged),
    );
}

export function openModelAssignmentPicker(rt: TuiRuntime, 
    assignment: ModelAssignmentId,
    parent?: TuiSettingsPickerState,
    selectedValue?: string,
): void {
    const targetState = focusedAgentState(rt);
    const row = currentModelAssignmentRows(rt).find((entry) => entry.assignment === assignment);
    const parentModel = targetState.modelSettings === undefined
        ? undefined
        : {
            ...(targetState.modelSettings.provider === undefined
                ? {}
                : { provider: targetState.modelSettings.provider }),
            model: targetState.modelSettings.model,
        };
    rt.settingsPicker = withTuiPickerParent(
        startTuiModelAssignmentPicker(
            assignment,
            row?.label ?? assignment,
            row?.intent ?? "",
            targetState.modelSettings?.availableModels?.map((entry) => ({ ...entry, available: true, verified: entry.verified === true })),
            row?.declared.map((entry) =>
                `${entry.provider}/${entry.model}`) ?? [],
            row?.allowSelf === true,
            parentModel,
            selectedValue,
        ),
        parent,
    );
    renderState(rt);
    focusActiveSurface(rt);
}

export function bindModelAssignmentFromPicker(rt: TuiRuntime, 
    selection: {
        readonly assignment: ModelAssignmentId;
        readonly provider?: string;
        readonly model?: string;
        readonly reasoningEffort?: ModelReasoningEffort;
        readonly acceptDefaultReasoning?: true;
        readonly remove?: boolean;
        readonly clear?: boolean;
        readonly allowSelf?: boolean;
    },
): string | undefined {
    if (selection.model !== undefined && selection.remove !== true && selection.clear !== true && selection.allowSelf === undefined) {
        if (!eligibleForDefault(loadPoolFile({ projectRoot: process.cwd() }).merged, { provider: selection.provider ?? "", model: selection.model })) return "Verify this model before assigning it as a default.";
    }
    const subagents = selection.assignment === "subagents";
    const row = subagents
        ? currentModelAssignmentRows(rt).find((entry) =>
            entry.assignment === "subagents")
        : undefined;
    const currentModels = row?.declared ?? [];
    const selectedRef = selection.model === undefined
        ? undefined
        : `${selection.provider ?? ""}/${selection.model}`;
    const models = !subagents
        ? []
        : selection.clear === true
        ? []
        : selection.allowSelf !== undefined
        ? [...currentModels]
        : selection.remove === true
        ? currentModels.filter((entry) =>
            `${entry.provider}/${entry.model}` !== selectedRef)
        : [
            ...currentModels.filter((entry) =>
                `${entry.provider}/${entry.model}` !== selectedRef),
            {
                name: derivedModelName(
                    selection.provider as VeraProviderId,
                    selection.model as string,
                ),
                provider: selection.provider as VeraProviderId,
                model: selection.model as string,
                ...(selection.reasoningEffort === undefined
                    ? {}
                    : { reasoning_effort: selection.reasoningEffort }),
            },
        ];
    const allowSelf = selection.allowSelf
        ?? (selection.clear === true ? false : row?.allowSelf === true);
    const unbinding = subagents
        ? models.length === 0 && !allowSelf
        : selection.model === undefined;
    try {
        updateVeraConfigDefaults({
            model_assignment: {
                assignment: selection.assignment,
                binding: unbinding ? null : subagents ? {
                    models,
                    ...(allowSelf ? { allow_self: true } : {}),
                } : {
                    models: [{
                        name: derivedModelName(
                            selection.provider as VeraProviderId,
                            selection.model as string,
                        ),
                        provider: selection.provider as VeraProviderId,
                        model: selection.model as string,
                        ...(selection.reasoningEffort === undefined
                            ? {}
                            : { reasoning_effort: selection.reasoningEffort }),
                    }],
                },
            },
        });
        requestAgentSettings(rt, focusedAgentClient(rt));
    } catch (error) {
        const message = `Could not write the assignment: ${
            error instanceof Error ? error.message : String(error)
        }`;
        rt.state = appendTuiError(rt.state, message);
        return message;
    }
    rt.state = appendTuiNotice(
        rt.state,
        unbinding
            ? `${selection.assignment} unset. The conversation model is unchanged.`
            : subagents
            ? `Subagent policy updated: ${models.length} assigned, parent fallback ${
                allowSelf ? "on" : "off"
            }.`
            : `${selection.assignment} → ${
                selection.reasoningEffort === undefined
                    ? selection.model
                    : `${selection.model} (${selection.reasoningEffort})`
            }. The conversation model is unchanged.`,
        "soft",
    );
    return undefined;
}

export function configureDisplayPath(rt: TuiRuntime, path: string): string {
    const home = homedir();
    const prefix = home.endsWith("/") ? home : `${home}/`;
    return path.startsWith(prefix) ? `~/${path.slice(prefix.length)}` : path;
}

export function configureFiles(rt: TuiRuntime): readonly TuiConfigureFile[] {
    const profileConfig = veraConfigPath();
    const files: TuiConfigureFile[] = [{
        label: "Profile config",
        path: profileConfig,
        displayPath: configureDisplayPath(rt, profileConfig),
        scope: "Profile",
        createIfMissing: true,
    }];
    const tuiPreferences = tuiThemePreferencePath();
    if (existsSync(tuiPreferences)) {
        files.push({
            label: "TUI preferences",
            path: tuiPreferences,
            displayPath: configureDisplayPath(rt, tuiPreferences),
            scope: "Profile",
            createIfMissing: false,
        });
    }
    const workspace = focusedAgentClient(rt).workspace;
    if (workspace !== undefined) {
        const projectConfig = join(workspace, ".vera", "config.json");
        if (existsSync(projectConfig)) {
            files.push({
                label: "Project config",
                path: projectConfig,
                displayPath: ".vera/config.json",
                scope: "Project",
                createIfMissing: false,
            });
        }
    }
    return files;
}

export function openConfigurePicker(rt: TuiRuntime): void {
    rt.settingsPickerAgent = focusedAgentClient(rt);
    rt.settingsPicker = startTuiConfigurePicker(configureFiles(rt));
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

export async function openConfigureEditor(rt: TuiRuntime, file: TuiConfigureFile): Promise<void> {
    if (!file.createIfMissing && !existsSync(file.path)) {
        rt.state = appendTuiError(
            rt.state,
            `${file.label} is no longer available: ${file.displayPath}`,
        );
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    rt.renderer.suspend();
    try {
        if (rt.dependencies.openConfigurationFile !== undefined) {
            await rt.dependencies.openConfigurationFile(file.path);
        } else if (
            file.path === veraConfigPath()
            && rt.dependencies.openConfigure !== undefined
        ) {
            await rt.dependencies.openConfigure();
        } else {
            await openFileInEditor(file.path);
        }
        rt.state = appendTuiNotice(
            rt.state,
            `${file.label} editor closed: ${file.displayPath}`,
        );
    } catch (error) {
        rt.state = appendTuiError(
            rt.state,
            `Could not open ${file.label.toLowerCase()}: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    } finally {
        rt.renderer.resume();
        renderState(rt);
        focusActiveSurface(rt);
    }
}

export function modelLevelFacts(rt: TuiRuntime, 
    provider: string | undefined,
    model: string | undefined,
    source: TuiState = focusedAgentState(rt),
): {
    readonly levels: readonly ReasoningLevel[];
    readonly defaultLevel?: ReasoningLevelId;
} | undefined {
    if (model === undefined) return undefined;
    return levelsForModel(
        provider,
        model,
        source.modelSettings?.pooled ?? [],
        source.modelSettings?.availableModels ?? [],
    );
}

export function currentModelLevels(rt: TuiRuntime): readonly ReasoningLevel[] {
    const targetState = focusedAgentState(rt);
    return modelLevelFacts(rt, 
        targetState.modelSettings?.provider,
        targetState.modelSettings?.model,
        targetState,
    )?.levels ?? [];
}

export function openReasoningPicker(rt: TuiRuntime, parent?: TuiSettingsPickerState): void {
    if (parent === undefined) rt.settingsPickerAgent = focusedAgentClient(rt);
    const targetState = focusedAgentState(rt);
    const levels = currentModelLevels(rt);
    if (levels.length === 0) {
        rt.state = appendTuiNotice(
            rt.state,
            `${
                targetState.modelSettings === undefined
                    ? "this model"
                    : `${targetState.modelSettings.provider}/${targetState.modelSettings.model}`
            } has no reasoning effort setting`,
        );
        renderState(rt);
        return;
    }
    const current = modelLevelFacts(rt, 
        targetState.modelSettings?.provider,
        targetState.modelSettings?.model,
        targetState,
    );
    rt.settingsPicker = withTuiPickerParent(startTuiReasoningPicker(
        levels,
        current?.defaultLevel,
        targetState.modelSettings?.reasoningEffort,
    ), parent);
    renderState(rt);
    focusActiveSurface(rt);
}

export function openPermissionsPicker(rt: TuiRuntime, parent?: TuiSettingsPickerState): void {
    if (parent === undefined) rt.settingsPickerAgent = focusedAgentClient(rt);
    const targetState = focusedAgentState(rt);
    if (targetState.permissionInspection !== undefined) {
        const notice = renderPermissionInspection(
            targetState.permissionInspection,
        );
        if (rt.sidebar.isFocused() && rt.hostedSidebar.pane !== undefined) {
            rt.hostedSidebar.pane.state.state = appendTuiNotice(
                rt.hostedSidebar.pane.state.state,
                notice,
            );
            renderSidebarAgent(rt, rt.hostedSidebar.pane);
        } else {
            rt.state = appendTuiNotice(rt.state, notice);
        }
    }
    rt.settingsPicker = withTuiPickerParent(startTuiSettingsPicker(
        "permissions",
        targetState.modelSettings?.model,
        targetState.modelSettings?.reasoningEffort,
        targetState.approvalMode,
        targetState.modelSettings?.availableModels,
        undefined,
        undefined,
        targetState.permissionInspection?.availableModes,
    ), parent);
    renderState(rt);
    focusActiveSurface(rt);
}

export function openThemePicker(rt: TuiRuntime, parent?: TuiSettingsPickerState): void {
    rt.settingsPicker = withTuiPickerParent(startTuiSettingsPicker(
        "theme",
        rt.state.modelSettings?.model,
        rt.state.modelSettings?.reasoningEffort,
        rt.state.approvalMode,
        rt.state.modelSettings?.availableModels,
        rt.themeName,
    ), parent);
    renderState(rt);
    focusActiveSurface(rt);
}

export function openPreferencesList(rt: TuiRuntime, parent?: TuiSettingsPickerState): void {
    rt.preferencesList = startTuiPreferencesList(rt.state.permissionInspection);
    rt.preferencesListParent = parent;
    sendCommand(rt, { type: "get_permissions", requestId: randomUUID() });
    rt.composer.blur();
    focusActiveSurface(rt);
    renderState(rt);
}

export function openStandingNudges(rt: TuiRuntime): void {
    adoptStandingNudgesState(rt, 
        openTuiStandingNudges(
            rt.standingNudgesProfileDirectory,
            focusedAgentClient(rt).workspace ?? "",
        ),
    );
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

export function providerHasCredential(rt: TuiRuntime, provider: Parameters<typeof isProviderConnected>[0]): boolean {
    try {
        return isProviderConnected(provider, { authStorage: rt.authStorage });
    } catch {
        return false;
    }
}

export function openProviderEditForm(rt: TuiRuntime, 
    provider: string,
    parent?: TuiSettingsPickerState,
): void {
    const declaration = loadOptionalVeraConfig()?.providers?.[provider];
    if (declaration === undefined) {
        return;
    }
    let apiKey: string | undefined;
    try {
        const stored = rt.authStorage.getCredential(provider);
        apiKey = stored?.type === "api_key" ? stored.key : undefined;
    } catch {
        apiKey = undefined;
    }
    rt.providerForm = startTuiProviderForm(parent, {
        id: provider,
        baseUrl: declaration.base_url,
        protocol: declaration.protocol,
        credential: declaration.credential,
        ...(apiKey === undefined ? {} : { apiKey }),
    });
    rt.settingsPicker = undefined;
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

export function onboardingInput(
    rt: TuiRuntime,
    config = loadOptionalVeraConfig(),
): OnboardingInput {
    return {
        providers: configuredProviders(config),
        pool: loadPoolFile({ projectRoot: process.cwd() }).merged,
        ...(config === undefined ? {} : { config }),
        authStorage: rt.authStorage,
    };
}

/** Home is built before the runtime credential store is assigned. */
export function homeNeedsProvider(rt: TuiRuntime): boolean {
    try {
        return connectedProviderCatalogs(loadOptionalVeraConfig(), {
            authStorage: rt.authStorage ?? rt.dependencies.authStorage ?? createAuthStorage(),
        }).length === 0;
    } catch {
        return false;
    }
}

/** The rows the provider screen shows. Pure, so the one thing that matters here can be tested: every provider is offered, whether or not it has answered yet. */
export function providerPickerRows(
    providers: readonly ProviderDescriptor[],
    answers: OnboardingInput,
    facts: {
        readonly connected: ReadonlySet<string>;
        readonly declared: ReadonlySet<string>;
        readonly refreshable: (provider: ProviderDescriptor) => boolean;
        readonly hasCredential: (provider: ProviderDescriptor) => boolean;
        readonly catalog: (id: string) => { readonly fetched_at?: string; readonly models: readonly unknown[] };
    },
): readonly TuiProviderRow[] {
    return providers.map((provider) => {
        const snapshot = facts.catalog(provider.id);
        const answerLabel = snapshot.fetched_at === undefined
            ? providerAnswerLabel(provider, answers) : "connected";
        // Catalog state is only news about a provider that is connected. On one
        // that is not, it is the same sentence on every row.
        const catalogHint = facts.connected.has(provider.id)
            ? (snapshot.fetched_at === undefined
                ? " \u00b7 catalog never refreshed"
                : ` \u00b7 catalog read: ${snapshot.models.length} models`)
            : "";
        return {
            id: provider.id,
            label: provider.label,
            group: tuiProviderGroup(
                provider.access,
                facts.declared.has(provider.id),
            ),
            hint: `${provider.custom || provider.endpointOverridden ? provider.baseUrl : provider.hint ?? provider.baseUrl ?? ""}${catalogHint}`,
            hasCredential: facts.hasCredential(provider),
            ...(answerLabel === undefined ? {} : { answerState: answerLabel }),
            ...(facts.refreshable(provider) ? { refreshable: true } : {}),
            ...(facts.declared.has(provider.id) ? { declared: true } : {}),
            ...(provider.fixedEndpoint === true ? {} : { endpointEditable: true }),
            ...(provider.localRuntime === undefined ? {} : { localRuntime: true }),
        };
    });
}

export function openProviderPicker(rt: TuiRuntime, 
    parent?: TuiSettingsPickerState,
    options: {
        readonly selected?: string;
        readonly subtitle?: string;
    } = {},
): void {
    const config = loadOptionalVeraConfig();
    const connected = new Set(connectedProviderCatalogs(config, { authStorage: rt.authStorage }).map((row) => row.id));
    const declared = new Set(Object.keys(config?.providers ?? {}));
    const rows = providerPickerRows(
        configuredProviders(config),
        onboardingInput(rt, config),
        {
            connected,
            declared,
            refreshable: (provider) => isRefreshableProvider(provider.id, config) || provider.protocol === "anthropic-messages",
            hasCredential: (provider) => providerHasCredential(rt, provider),
            catalog: (id) => readProviderCatalogSnapshot(id),
        },
    );
    rt.settingsPicker = withTuiPickerParent(
        startTuiProviderPicker(
            rows,
            {
                ...options,
                subtitle: options.subtitle ?? (connected.size ? undefined : "No provider connected. Choose one below, or add an endpoint of your own."),
                ...(rt.localRuntime === undefined ? {} : { localRuntime: rt.localRuntime }),
            },
        ),
        parent,
    );
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
    // The reading is slower than the screen, so it lands into the section once
    // it arrives rather than holding the screen shut.
    void refreshLocalRuntimeStatus(rt);
}

export function refreshProviderPicker(rt: TuiRuntime, notice: string): void {
    const previous = rt.settingsPicker;
    if (previous?.kind !== "provider") return;
    const selected = previous.options[previous.selectedIndex]?.value;
    openProviderPicker(rt, previous.parent, { selected, subtitle: notice });
    const current = rt.settingsPicker;
    if (current?.kind !== "provider") return;
    const searched = updateTuiSettingsPickerSearch(current, previous.query, previous.queryCursor).state!;
    rt.settingsPicker = { ...searched, selectedIndex: Math.max(0, searched.options.findIndex((row) => row.value === selected)) };
}

/** Opens whatever the provider needs to be usable, and says which credential it asked for. A caller walking the gates reads `none` as the key step being already done, and `install` as a gate that is still open. */
export function connectProvider(rt: TuiRuntime, 
    providerId: string,
    pane: TuiSettingsPickerState | undefined,
): "key" | "none" | "sign_in" | "install" | undefined {
    const provider = findConfiguredProvider(
        providerId,
        loadOptionalVeraConfig(),
    );
    if (provider === undefined) {
        return undefined;
    }
    if (
        provider.credential === "api_key"
        || provider.credential === "api_key_optional"
    ) {
        rt.secretPrompt = startTuiSecretPrompt(provider, pane);
        rt.settingsPicker = undefined;
        rt.composer.blur();
        renderState(rt);
        focusActiveSurface(rt);
        return "key";
    }
    rt.settingsPicker = undefined;
    closeSettingsPickerSurface(rt);
    // What this provider needs is a binary, not a credential, and saying it
    // needs nothing is wrong whenever the binary is not on the machine.
    if (provider.localRuntime !== undefined) {
        return "install";
    }
    if (provider.credential === "none") {
        rt.state = appendTuiNotice(
            rt.state,
            `${provider.label} needs no credentials${
                provider.envVar === undefined
                    ? ""
                    : `, point it elsewhere with ${provider.envVar}`
            }`,
            "soft",
        );
        renderState(rt);
        return "none";
    }
    if (rt.connectingProviders.has(provider.id)) {
        return "sign_in";
    }
    rt.connectingProviders.add(provider.id);
    rt.state = appendTuiNotice(
        rt.state,
        `opening your browser to sign in to ${provider.label}…`,
        "soft",
    );
    renderState(rt);
    void (rt.dependencies.loginProvider ?? ((providerId: string, onAuthorizationUrl: (url: string) => void) => defaultLoginProvider(rt, providerId, onAuthorizationUrl)))(
        provider.id,
        (url) => {
            rt.state = appendTuiNotice(
                rt.state,
                `browser didn't open? sign in here: ${url}`,
                "soft",
            );
            renderState(rt);
        },
    ).then(() => {
        rt.connectingProviders.delete(provider.id);
        rt.state = appendTuiNotice(
            rt.state,
            `✓ signed in to ${provider.label}`,
            "success",
        );
        // The credential alone changes no list: the host only learns the
        // provider's models when it is asked to read them again.
        requestCatalogRefresh(rt, provider.id);
    }, (error: unknown) => {
        rt.connectingProviders.delete(provider.id);
        rt.state = appendTuiError(
            rt.state,
            `could not connect to ${provider.label}: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        renderState(rt);
    });
    return "sign_in";
}
