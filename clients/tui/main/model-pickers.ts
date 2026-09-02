import { configuredModelAssignments, loadOptionalVeraConfig, updateVeraConfigDefaults, type VeraProviderId } from "../../../src/config.ts";
import type { ModelAssignmentId, ModelAssignmentRow } from "../../../src/config/model-assignments.ts";
import { derivedModelName } from "../../../src/config/model-catalog.ts";
import type { ModelSettingsPatch } from "../../../src/engine/model-settings.ts";
import { poolReachability } from "../../../src/model/assignment-reachability.ts";
import type { ReasoningLevel, ReasoningLevelId } from "../../../src/model/catalog-shape.ts";
import { levelsForModel } from "../../../src/model/catalog-view.ts";
import { loadPoolFile } from "../../../src/model/pool-file-loader.ts";
import type { ModelReasoningEffort } from "../../../src/model/types.ts";
import { openGate, providerAnswerLabel, stepPosition, stepperSteps, type OnboardingInput } from "../../../src/providers/onboarding.ts";
import { configuredProviders, findConfiguredProvider, isProviderConnected } from "../../../src/providers/registry.ts";
import { openFileInEditor, veraConfigPath } from "../../editor.ts";
import { isHomeClient } from "../home-client.ts";
import { closeSettingsPickerSurface, defaultLoginProvider } from "../main.ts";
import { focusedAgentClient, focusedAgentState } from "../main/agents-dials.ts";
import { adoptStandingNudgesState } from "../main/chrome.ts";
import { requestAgentSettings } from "../main/diagnostics-ops.ts";
import { sendCommand } from "../main/extension-bridge.ts";
import { focusActiveSurface } from "../main/focus-switch.ts";
import { renderState } from "../main/render-state.ts";
import { onboardingRail } from "../onboarding-rail.ts";
import { renderSidebarAgent } from "../main/sidebar-pane.ts";
import { renderPermissionInspection } from "../permission-inspection.ts";
import { startTuiPreferencesList } from "../preferences-list.ts";
import { startTuiSecretPrompt } from "../secret-prompt.ts";
import { startTuiConfigurePicker, startTuiModelAssignmentPicker, startTuiOnboardingModelPicker, startTuiProviderForm, startTuiProviderPicker, startTuiReasoningPicker, startTuiReviewerMenu, startTuiReviewerPicker, startTuiSettingsPicker, switchedModelTab, tuiModelActionOptions, tuiModelAssignmentOptions, tuiProviderGroup, withTuiPickerParent, type TuiConfigureFile, type TuiReviewerSlot, type TuiSettingsPickerOption, type TuiSettingsPickerState } from "../settings-picker.ts";
import { openTuiStandingNudges } from "../standing-nudges.ts";
import { appendTuiError, appendTuiNotice, type TuiState } from "../state.ts";
import { tuiThemePreferencePath } from "../theme-preference.ts";
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
        modelCatalogUnavailable: targetState.modelSettings === undefined
            && isHomeClient(focusedAgentClient(rt)),
    };
    if (rt.settingsPicker.tab === "pool" && currentShortlisted === false) {
        rt.settingsPicker = {
            ...switchedModelTab(rt.settingsPicker, "pool"),
            selectedIndex: 0,
        };
    }
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
    const configured = loadOptionalVeraConfig();
    if (configured === undefined) {
        return [];
    }
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
            targetState.modelSettings?.pooled,
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
            ? `${selection.assignment} unset. This session uses the fallback.`
            : subagents
            ? `Subagent policy updated: ${models.length} assigned, parent fallback ${
                allowSelf ? "on" : "off"
            }.`
            : `${selection.assignment} → ${
                selection.reasoningEffort === undefined
                    ? selection.model
                    : `${selection.model} (${selection.reasoningEffort})`
            }. This session uses it.`,
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

function onboardingInput(
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

/** The rail belongs over the provider list only while onboarding is unfinished. A user who already has a working provider is adding a second one, not being walked through the gates. */
function onboardingRailOptions(
    input: OnboardingInput,
): { readonly subtitle?: string } {
    if (openGate(input) === "ready") return {};
    const steps = stepperSteps(input);
    return { subtitle: onboardingRail(steps, stepPosition(input)) };
}

/** The rail over the key step, which names the provider the user just chose. */
function onboardingRailFor(
    rt: TuiRuntime,
    chosen: string,
    refusedKey = false,
): string | undefined {
    const input = { ...onboardingInput(rt), chosen, refusedKey };
    if (openGate(input) === "ready") return undefined;
    return onboardingRail(stepperSteps(input), stepPosition(input));
}

/** The last gate. The models are the ones the session already knows about, narrowed to the provider the user picked. */
export function openOnboardingModelStep(
    rt: TuiRuntime,
    provider: string,
): void {
    const models = (focusedAgentState(rt).modelSettings?.availableModels ?? [])
        .filter((model) => model.provider === provider)
        .map((model) => ({ model: model.model, label: model.label }));
    if (models.length === 0) {
        // The provider answered no list, so the shortlist's own entry is the
        // way through rather than a step with nothing on it.
        rt.state = appendTuiNotice(
            rt.state,
            `${provider} listed no models, open the model picker to name one`,
            "soft",
        );
        renderState(rt);
        return;
    }
    rt.settingsPicker = startTuiOnboardingModelPicker(
        provider,
        models,
        onboardingRailFor(rt, provider) ?? "",
    );
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

/** Whether any provider has answered yet. The card leads with Connect until one has. */
export function homeNeedsProvider(rt: TuiRuntime): boolean {
    try {
        return openGate(onboardingInput(rt)) !== "ready";
    } catch {
        return false;
    }
}

export function openProviderPicker(rt: TuiRuntime, 
    parent?: TuiSettingsPickerState,
    options: {
        readonly selected?: string;
        readonly subtitle?: string;
    } = {},
): void {
    const config = loadOptionalVeraConfig();
    const providers = configuredProviders(config);
    const answers = onboardingInput(rt, config);
    const declared = new Set(Object.keys(config?.providers ?? {}));
    const moved = new Set(Object.keys(config?.provider_endpoints ?? {}));
    const targetState = rt.state;
    const refreshable = new Set(refreshableProvidersOf(rt, 
        targetState.modelSettings?.availableModels,
        targetState.modelSettings?.refreshableProviders,
    ));
    rt.settingsPicker = withTuiPickerParent(
        startTuiProviderPicker(
            providers.map((provider) => {
                const answerLabel = providerAnswerLabel(provider, answers);
                return {
                    id: provider.id,
                    label: provider.label,
                    group: tuiProviderGroup(
                        provider.access,
                        declared.has(provider.id),
                    ),
                    ...(moved.has(provider.id)
                        ? { hint: provider.baseUrl ?? "" }
                        : provider.hint === undefined
                        ? {}
                        : { hint: provider.hint }),
                    hasCredential: providerHasCredential(rt, provider),
                    ...(answerLabel === undefined
                        ? {}
                        : { answerState: answerLabel }),
                    ...(refreshable.has(provider.id)
                        ? { refreshable: true }
                        : {}),
                    ...(declared.has(provider.id) ? { declared: true } : {}),
                    ...(provider.fixedEndpoint === true
                        ? {}
                        : { endpointEditable: true }),
                };
            }),
            { ...onboardingRailOptions(answers), ...options },
        ),
        parent,
    );
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

export function connectProvider(rt: TuiRuntime, 
    providerId: string,
    pane: TuiSettingsPickerState | undefined,
    refusal?: string,
): void {
    const provider = findConfiguredProvider(
        providerId,
        loadOptionalVeraConfig(),
    );
    if (provider === undefined) {
        return;
    }
    if (
        provider.credential === "api_key"
        || provider.credential === "api_key_optional"
    ) {
        rt.secretPrompt = startTuiSecretPrompt(
            provider,
            pane,
            onboardingRailFor(rt, provider.id, refusal !== undefined),
            refusal,
        );
        rt.settingsPicker = undefined;
        rt.composer.blur();
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    rt.settingsPicker = undefined;
    closeSettingsPickerSurface(rt);
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
        return;
    }
    if (rt.connectingProviders.has(provider.id)) {
        return;
    }
    rt.connectingProviders.add(provider.id);
    rt.state = appendTuiNotice(
        rt.state,
        `opening a browser to sign in to ${provider.label}…`,
        "soft",
    );
    renderState(rt);
    void (rt.dependencies.loginProvider ?? ((providerId: string, onAuthorizationUrl: (url: string) => void) => defaultLoginProvider(rt, providerId, onAuthorizationUrl)))(
        provider.id,
        (url) => {
            rt.state = appendTuiNotice(rt.state, `sign in at ${url}`);
            renderState(rt);
        },
    ).then(() => {
        rt.connectingProviders.delete(provider.id);
        rt.state = appendTuiNotice(rt.state, `signed in to ${provider.label}`, "soft");
        renderState(rt);
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
}
