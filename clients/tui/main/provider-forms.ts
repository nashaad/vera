import { readModelCatalog } from "../../../src/providers/read-model-catalog.ts";
import { normalizeOpenRouterModels } from "../../../src/model/openrouter-catalog.ts";
import { writeProviderCatalogSnapshot } from "../../../src/model/catalog-cache.ts";
import { isProviderConnected } from "../../../src/providers/registry.ts";
import { runModelOperation } from "./model-operations.ts";
import { modelJourney } from "../model-journeys.ts";
import { loadOptionalVeraConfig, updateVeraConfigDefaults } from "../../../src/config.ts";
import { isConfigurationRequiredUiRequestUpdate, type UiRequestUpdate } from "../../../src/engine/protocol.ts";
import type { RenameSessionResult } from "../../../src/host/session-rename-client.ts";
import { DEFAULT_PROFILE_NAME } from "../../../src/profile-paths.ts";
import { loginOpenAICodex } from "../../../src/providers/openai-codex-oauth.ts";
import { configuredProviders, findConfiguredProvider } from "../../../src/providers/registry.ts";
import type { TuiAgentClient } from "../agent-client.ts";
import { SESSION_SWITCH_TIMEOUT_MS, closeSettingsPickerSurface, refreshWorkspaceSidebarRoster } from "../main.ts";
import { focusedAgentClient, focusedAgentState, openAgentPicker, setSidebarFocused } from "../main/agents-dials.ts";
import { requestAgentSettings } from "../main/diagnostics-ops.ts";
import { sendCommand } from "../main/extension-bridge.ts";
import { focusActiveSurface, reportConnectionError } from "../main/focus-switch.ts";
import { openModelSwitcher } from "../main/model-switcher-ops.ts";
import { currentModelAssignmentRows, homeNeedsProvider, modelRequestOptionsFacts, openModelAssignmentPicker, openModelPicker, openPermissionsPicker, openProviderPicker, openReasoningPicker } from "../main/model-pickers.ts";
import { enterWizardModelStep } from "../main/onboarding-wizard-ops.ts";
import { renderState } from "../main/render-state.ts";
import type { TuiNamePromptState, TuiNamePromptTransition } from "../name-prompt.ts";
import { tuiProviderForgetDecision } from "../provider-forget-confirm.ts";
import { startTuiRequestOptionsEditor, type TuiRequestOptionsEditorTransition } from "../request-options-editor.ts";
import { startTuiSecretPrompt, type TuiSecretPromptState } from "../secret-prompt.ts";
import { resolveTuiSettingsDestination } from "../settings-destination.ts";
import { startTuiProviderForm, startTuiSessionPicker, startTuiSettingsMenu, type TuiProviderFormState, type TuiProviderFormTransition, type TuiSettingsPickerState, type TuiSettingsPickerTransition } from "../settings-picker.ts";
import { appendTuiError, appendTuiNotice } from "../state.ts";
import type { TuiRuntime } from "./runtime.ts";
import { randomUUID } from "node:crypto";

export function forgetProvider(rt: TuiRuntime, 
    providerId: string,
    pane: TuiSettingsPickerState | undefined,
): void {
    const provider = findConfiguredProvider(
        providerId,
        loadOptionalVeraConfig(),
    );
    if (provider === undefined) {
        return;
    }
    let stored;
    try {
        stored = rt.authStorage.getCredential(provider.id);
    } catch {
        stored = undefined;
    }
    const decision = tuiProviderForgetDecision(
        provider,
        stored !== undefined,
        provider.envVar === undefined
            ? undefined
            : process.env[provider.envVar],
    );
    if (decision.kind === "explain") {
        openProviderPicker(rt, pane, {
            selected: provider.id,
            subtitle: decision.message,
        });
        return;
    }
    rt.providerForgetCandidate = {
        providerId: provider.id,
        label: provider.label,
        pane,
    };
    rt.composer.blur();
    rt.providerForgetConfirmView.update(provider.label, (rt.state.modelSettings?.pooled ?? []).filter((row) => row.provider === provider.id).length);
    renderState(rt);
    focusActiveSurface(rt);
}

export function forgetProviderCredential(rt: TuiRuntime, candidate: {
    readonly providerId: string;
    readonly label: string;
    readonly pane: TuiSettingsPickerState | undefined;
}): void {
    rt.providerForgetCandidate = undefined;
    const caller = rt.settingsPicker;
    renderState(rt);
    focusActiveSurface(rt);
    const forget = rt.dependencies.forgetProvider;
    if (forget === undefined) {
        rt.state = appendTuiError(rt.state, "This host does not support forgetting providers.");
        renderState(rt); return;
    }
    void forget(candidate.providerId, focusedAgentClient(rt).workspace).then((settings) => {
        if (settings !== undefined && rt.state.modelSettings !== undefined) {
            const current = rt.state.modelSettings;
            rt.state = { ...rt.state, modelSettings: { ...current, availableModels: settings.availableModels, pooled: settings.pooled,
                ...(current.provider === candidate.providerId ? { selectionCleared: true } : {}) } };
        }
        rt.state = appendTuiNotice(rt.state, `Forgot ${candidate.label}. Its models were removed, affected defaults unset, and conversation selections cleared.`);
        requestAgentSettings(rt, focusedAgentClient(rt));
        if (rt.settingsPicker === caller) openProviderPicker(rt, candidate.pane);
    }).catch((error) => {
        rt.state = appendTuiError(rt.state, `Could not finish forgetting ${candidate.label}: ${error instanceof Error ? error.message : String(error)}`);
        if (rt.settingsPicker === caller) openProviderPicker(rt, candidate.pane);
    });
}

export async function defaultLoginProvider(rt: TuiRuntime, 
    providerId: string,
    onAuthorizationUrl: (url: string) => void,
): Promise<void> {
    if (providerId !== "openai-codex") {
        throw new Error(`No sign-in flow for provider ${providerId}`);
    }
    await loginOpenAICodex({ authStorage: rt.authStorage, onAuthorizationUrl });
}

export function openProviderEndpointForm(rt: TuiRuntime, 
    providerId: string,
    parent?: TuiSettingsPickerState,
): void {
    const config = loadOptionalVeraConfig();
    const provider = findConfiguredProvider(providerId, config);
    if (provider === undefined || provider.fixedEndpoint === true) {
        return;
    }
    let apiKey: string | undefined;
    try {
        const stored = rt.authStorage.getCredential(providerId);
        apiKey = stored?.type === "api_key" ? stored.key : undefined;
    } catch {
        apiKey = undefined;
    }
    rt.providerForm = startTuiProviderForm(parent, {
        id: providerId,
        baseUrl: provider.baseUrl ?? "",
        protocol: "openai-chat",
        credential: provider.credential === "none" ? "none" : "api_key",
        shipped: true,
        ...(apiKey === undefined ? {} : { apiKey }),
    });
    rt.settingsPicker = undefined;
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

export function openRequestOptionsEditor(rt: TuiRuntime, 
    candidate: NonNullable<TuiSettingsPickerTransition["requestOptions"]>,
    parent: TuiSettingsPickerState,
): void {
    try {
        const config = loadOptionalVeraConfig();
        const reference = `${candidate.provider}/${candidate.model}`;
        rt.requestOptionsEditor = startTuiRequestOptionsEditor(
            candidate,
            DEFAULT_PROFILE_NAME,
            config?.model_request_options?.[reference]?.body,
            parent,
        );
        rt.settingsPicker = undefined;
        rt.composer.blur();
        renderState(rt);
        focusActiveSurface(rt);
    } catch (error) {
        rt.state = appendTuiError(
            rt.state,
            error instanceof Error ? error.message : String(error),
        );
        rt.settingsPicker = parent;
        renderState(rt);
    }
}

export function applyRequestOptionsEditorTransition(rt: TuiRuntime, 
    transition: TuiRequestOptionsEditorTransition,
): void {
    const previous = rt.requestOptionsEditor;
    rt.requestOptionsEditor = transition.state;
    if (rt.requestOptionsEditor !== undefined) {
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    if (previous === undefined) return;
    if (transition.save === undefined) {
        rt.settingsPicker = previous.parent;
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    const save = transition.save;
    const reference = `${save.provider}/${save.model}`;
    try {
        updateVeraConfigDefaults({
            model_request_options: {
                model: reference,
                body: save.body,
            },
        });
    } catch (error) {
        rt.requestOptionsEditor = {
            ...previous,
            error: error instanceof Error ? error.message : String(error),
        };
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    rt.settingsPicker = {
        ...save.parent,
        ...modelRequestOptionsFacts(rt),
    };
    rt.state = appendTuiNotice(
        rt.state,
        `saved request options for ${reference}`,
        "soft",
    );
    renderState(rt);
    focusActiveSurface(rt);
}

export function applyProviderFormTransition(rt: TuiRuntime, 
    form: TuiProviderFormState,
    transition: TuiProviderFormTransition,
): void {
    rt.providerForm = transition.state;
    if (rt.providerForm !== undefined) {
        const fieldChanged = form.field !== rt.providerForm.field;
        renderState(rt);
        // Hidden field editors keep focus until we move it. Same-field typing
        // must not refocus or the native cursor resets.
        if (fieldChanged) {
            focusActiveSurface(rt);
        }
        return;
    }
    const submitted = transition.submitted;
    if (submitted === undefined) {
        rt.settingsPicker = form.parent;
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    rt.providerForm = { ...form, saving: true };
    renderState(rt);
    void saveProviderForm(rt, form, submitted);
}

async function saveProviderForm(rt: TuiRuntime, form: TuiProviderFormState, submitted: NonNullable<TuiProviderFormTransition["submitted"]>): Promise<void> {
    try {
        const provider = findConfiguredProvider(submitted.id, loadOptionalVeraConfig());
        if (form.editing === undefined && provider !== undefined
            && isProviderConnected(provider, { authStorage: rt.authStorage })
            && provider.credential !== "none") throw new Error(`${submitted.id} is already connected`);
        const stored = rt.authStorage.getCredential(submitted.id);
        const key = submitted.apiKey ?? (stored?.type === "api_key" ? stored.key : undefined)
            ?? (provider?.envVar === undefined ? undefined : process.env[provider.envVar]);
        if (submitted.declaration.credential === "api_key" && !key) throw new Error("Missing API key");
        const catalog = await readModelCatalog({ provider: submitted.id, baseUrl: submitted.declaration.base_url,
            ...(provider?.behaviorId === "openrouter" ? { normalize: normalizeOpenRouterModels } : {}),
            protocol: submitted.declaration.protocol, ...(key === undefined ? {} : { apiKey: key }) });
        updateVeraConfigDefaults(
            submitted.shipped === true
                ? {
                    provider_endpoint: {
                        id: submitted.id,
                        url: submitted.restore === true
                            ? null
                            : submitted.declaration.base_url,
                    },
                }
                : {
                    custom_provider: {
                        id: submitted.id,
                        declaration: submitted.declaration,
                    },
                },
        );
        if (submitted.apiKey !== undefined) rt.authStorage.setCredential(submitted.id, { type: "api_key", key: submitted.apiKey });
        writeProviderCatalogSnapshot(catalog);
        if (submitted.replaces !== undefined) {
            updateVeraConfigDefaults({ custom_provider: { id: submitted.replaces, declaration: null } });
            rt.authStorage.deleteCredential(submitted.replaces);
        }
        rt.providerForm = undefined;
        const notice = `${provider?.label ?? submitted.id} saved and its catalog read: ${catalog.models.length} models discovered. `
            + "Discovery decides nothing: none is in your library, verified, or bound.";
        requestAgentSettings(rt, focusedAgentClient(rt));
        const providerList = form.parent?.kind === "provider_actions" ? form.parent.parent : form.parent;
        openProviderPicker(rt, providerList?.parent, { selected: submitted.id, subtitle: notice });
    } catch (error) {
        rt.providerForm = { ...form, field: "base_url",
            error: `${error instanceof Error ? error.message : String(error)}. Your input is preserved` };
        renderState(rt);
        focusActiveSurface(rt);
    }
}

export function applySecretPromptTransition(rt: TuiRuntime, 
    prompt: TuiSecretPromptState,
    transition: { readonly state?: TuiSecretPromptState; readonly submitted?: string },
): void {
    rt.secretPrompt = transition.state;
    if (rt.secretPrompt !== undefined) {
        renderState(rt);
        return;
    }
    if (rt.extensionSecretPrompt) {
        rt.extensionSecretPrompt(transition.submitted);
        return;
    }
    if (transition.submitted !== undefined) {
        try {
            rt.authStorage.setCredential(prompt.providerId, {
                type: "api_key",
                key: transition.submitted,
            });
            rt.state = appendTuiNotice(rt.state, `stored ${prompt.label} API key`);
            requestAgentSettings(rt, focusedAgentClient(rt));
        } catch (error) {
            rt.state = appendTuiError(
                rt.state,
                `could not store the ${prompt.label} API key: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
    // A stored key is the second gate, not the last one. While no provider has
    // answered, the flow carries straight on to the model step.
    if (transition.submitted !== undefined && homeNeedsProvider(rt)) {
        enterWizardModelStep(rt, prompt.providerId);
        return;
    }
    if (transition.submitted !== undefined && prompt.parent?.kind === "provider") {
        openProviderPicker(rt, prompt.parent.parent);
        return;
    }
    rt.settingsPicker = prompt.parent;
    if (rt.settingsPicker?.kind === "model") {
        requestAgentSettings(rt, focusedAgentClient(rt));
    }
    renderState(rt);
    focusActiveSurface(rt);
}

export function applySessionRenamePromptTransition(rt: TuiRuntime, 
    prompt: TuiNamePromptState,
    transition: TuiNamePromptTransition,
): void {
    rt.namePrompt = transition.state;
    if (rt.namePrompt !== undefined) {
        renderState(rt);
        return;
    }
    const parent = prompt.parent;
    rt.settingsPicker = prompt.target.kind === "pool"
        ? rt.settingsPicker ?? parent
        : parent;
    if (transition.submitted !== undefined && prompt.target.kind === "pool" && parent?.modelJourney === "shortlist") {
        runModelOperation(rt, { operation: "rename", displayName: transition.submitted ?? "",
            models: [{ provider: prompt.target.provider, model: prompt.target.model }] });
    } else if (transition.submitted !== undefined && prompt.target.kind === "pool") {
        sendCommand(rt, {
            type: "pool_name",
            requestId: randomUUID(),
            provider: prompt.target.provider,
            model: prompt.target.model,
            name: transition.submitted,
        });
    } else if (
        transition.submitted !== undefined
        && prompt.target.kind === "session"
    ) {
        if (prompt.target.sessionId === rt.client.agentId) {
            const requestId = randomUUID();
            rt.pendingSessionRename = { requestId };
            sendCommand(rt, {
                type: "update_session_name",
                requestId,
                name: transition.submitted,
            });
        } else if (
            prompt.target.sessionId === rt.hostedSidebar.pane?.agentId
        ) {
            const requestId = randomUUID();
            const target = rt.hostedSidebar.pane;
            rt.pendingSidebarSessionRename = { requestId };
            void target.client.send({
                type: "update_session_name",
                requestId,
                name: transition.submitted,
            }).catch((error) => {
                if (rt.pendingSidebarSessionRename?.requestId !== requestId) {
                    return;
                }
                rt.pendingSidebarSessionRename = undefined;
                reportConnectionError(rt, error);
            });
        } else {
            void performSessionRename(rt, 
                prompt.target.sessionId,
                transition.submitted,
            );
        }
    }
    renderState(rt);
    focusActiveSurface(rt);
}

export async function performSessionRename(rt: TuiRuntime, 
    sessionId: string,
    name: string | null,
): Promise<void> {
    if (rt.dependencies.renameSession === undefined) {
        rt.state = appendTuiError(
            rt.state,
            "Renaming another conversation is unavailable",
        );
        renderState(rt);
        return;
    }
    const generation = rt.clientGeneration;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
        rt.dependencies.renameSession(sessionId, name)
            .catch((): RenameSessionResult => ({
                status: "rejected",
                reason: "failed",
            })),
        new Promise<RenameSessionResult>((resolve) => {
            timeout = setTimeout(() => {
                resolve({ status: "rejected", reason: "failed" });
            }, rt.dependencies.sessionSwitchTimeoutMs
                ?? SESSION_SWITCH_TIMEOUT_MS);
        }),
    ]);
    clearTimeout(timeout);
    if (rt.shuttingDown || generation !== rt.clientGeneration) return;
    rt.state = result.status === "renamed"
        ? appendTuiNotice(
            rt.state,
            result.name === null
                ? "session name cleared"
                : `session renamed: ${result.name}`,
        )
        : appendTuiError(
            rt.state,
            result.reason === "busy"
                ? "That conversation is open in another client"
                : result.reason === "not_found"
                ? "That conversation is no longer available"
                : result.reason === "invalid"
                ? "Session name must be 1 to 200 UTF-8 bytes"
                : "Could not rename that conversation",
        );
    if (result.status === "renamed" && rt.settingsPicker?.kind === "session") {
        await refreshSessionPicker(rt);
    }
    if (result.status === "renamed" && rt.workspaceSidebar !== undefined) {
        refreshWorkspaceSidebarRoster(rt);
    }
    renderState(rt);
}

export async function refreshSessionPicker(rt: TuiRuntime): Promise<void> {
    if (rt.dependencies.listAgents === undefined) return;
    const generation = rt.clientGeneration;
    try {
        const agents = await rt.dependencies.listAgents();
        if (
            rt.shuttingDown || generation !== rt.clientGeneration
            || rt.settingsPicker?.kind !== "session"
        ) {
            return;
        }
        rt.settingsPicker = startTuiSessionPicker(
            agents,
            rt.client.agentId,
            false,
            new Date(),
            false,
            rt.hostedPanePersistence.groups,
            rt.settingsPicker.enterDisposition ?? "stop",
        );
        renderState(rt);
    } catch {
    }
}

export function openSettingsMenu(rt: TuiRuntime): void {
    rt.settingsPickerAgent = focusedAgentClient(rt);
    rt.settingsPicker = startTuiSettingsMenu(
        "settings",
        focusedAgentState(rt)?.modelSettings?.overrides,
    );
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

export function openSettingsDestination(rt: TuiRuntime, 
    destination: unknown,
    options: {
        readonly parent?: TuiSettingsPickerState;
    } = {},
): "opened" | "unavailable" {
    const resolution = resolveTuiSettingsDestination(destination, {
        permissionModes:
            focusedAgentState(rt).permissionInspection?.availableModes,
    });
    if (resolution.status === "unsupported") {
        rt.state = appendTuiNotice(
            rt.state,
            "That settings destination is unavailable in this client.",
        );
        renderState(rt);
        return "unavailable";
    }
    const route = resolution.route;
    if (route.type === "settings_menu") {
        openSettingsMenu(rt);
    } else if (route.type === "model_picker") {
        // Nested inside a picker chain, or answering a configuration request,
        // the caller needs a pane that can return; elsewhere switching is the job.
        if (options.parent === undefined && rt.activeConfigurationRequest === undefined) {
            openModelSwitcher(rt);
        } else openModelPicker(rt, options.parent);
    } else if (route.type === "reasoning_picker") {
        openReasoningPicker(rt, options.parent);
    } else if (route.type === "permission_mode_picker") {
        openPermissionsPicker(rt, options.parent);
    } else if (route.type === "agent_picker") {
        void openAgentPicker(rt, route.name);
    } else if (route.type === "provider_picker") {
        if (
            route.provider !== undefined
            && !configuredProviders(loadOptionalVeraConfig()).some(
                (provider) => provider.id === route.provider,
            )
        ) {
            rt.state = appendTuiNotice(
                rt.state,
                `No provider named ${route.provider}; that settings destination is unavailable.`,
            );
            renderState(rt);
            return "unavailable";
        }
        openProviderPicker(rt, options.parent, {
            ...(route.provider === undefined
                ? {}
                : { selected: route.provider }),
        });
    } else if (route.type === "model_shortlist") {
        openModelPicker(rt, options.parent);
        rt.settingsPicker = modelJourney(
            rt.settingsPicker as TuiSettingsPickerState,
            "shortlist",
        );
        renderState(rt);
    } else if (route.type === "model_assignments") {
        const rows = currentModelAssignmentRows(rt).map((row) => ({
            value: row.assignment, label: row.label,
            description: row.declared.length > 0 ? row.declared.map((model) => `${model.provider}/${model.model}`).join(" → ")
                : ["snappy", "eco", "extra"].includes(row.assignment) ? "unset, no model bound" : "unset, inherits its intent",
        }));
        rt.settingsPicker = { kind: "model_defaults", title: "Assign model defaults", query: "", selectedIndex: 0,
            allOptions: rows, options: rows, parent: options.parent,
            subtitle: "Only verified models in your library are eligible. Assigning leaves the conversation model unchanged." };
        renderState(rt);
        focusActiveSurface(rt);
    } else {
        openModelAssignmentPicker(rt, route.assignment, options.parent);
    }
    return "opened";
}

export function openConfigurationRequiredRequest(rt: TuiRuntime, 
    request: UiRequestUpdate,
    target: TuiAgentClient,
): void {
    if (!isConfigurationRequiredUiRequestUpdate(request)) return;
    if (rt.activeConfigurationRequest?.requestId === request.requestId) return;
    if (rt.activeConfigurationRequest !== undefined) {
        if (!rt.queuedConfigurationRequests.some((queued) =>
            queued.request.requestId === request.requestId
            && queued.target === target)) {
            rt.queuedConfigurationRequests.push({ request, target });
        }
        return;
    }
    activateConfigurationRequiredRequest(rt, request, target);
}

export function activateConfigurationRequiredRequest(rt: TuiRuntime, 
    request: UiRequestUpdate,
    target: TuiAgentClient,
): void {
    if (!isConfigurationRequiredUiRequestUpdate(request)) return;
    rt.activeConfigurationRequest = { requestId: request.requestId, target };
    if (rt.hostedSidebar.pane?.client === target) {
        setSidebarFocused(rt, true);
    } else if (rt.client === target) {
        setSidebarFocused(rt, false);
    }
    rt.settingsPickerAgent = target;
    rt.state = appendTuiNotice(
        rt.state,
        `${request.request.reason} (${request.request.pendingAction.count} waiting)`,
        "soft",
    );

    const opened = openSettingsDestination(rt, request.request.destination, {});
    if (opened === "unavailable") {
        respondToConfigurationRequired(rt, "unavailable");
    }
}

export function respondToConfigurationRequired(rt: TuiRuntime, 
    outcome: "configured" | "cancelled" | "unavailable",
): void {
    const pending = rt.activeConfigurationRequest;
    if (pending === undefined) return;
    rt.activeConfigurationRequest = undefined;
    rt.settingsPicker = undefined;
    closeSettingsPickerSurface(rt);
    void pending.target.send({
        type: "ui_response",
        requestId: pending.requestId,
        response: { type: "configuration_required", outcome },
    }).catch(((error: unknown) => reportConnectionError(rt, error)));
    renderState(rt);
    focusActiveSurface(rt);
    openNextConfigurationRequiredRequest(rt);
}

export function openNextConfigurationRequiredRequest(rt: TuiRuntime): void {
    if (rt.activeConfigurationRequest !== undefined) return;
    const next = rt.queuedConfigurationRequests.shift();
    if (next === undefined) return;
    activateConfigurationRequiredRequest(rt, next.request, next.target);
}

export function finishConfigurationPicker(rt: TuiRuntime): void {
    const subagents = currentModelAssignmentRows(rt).find((row) =>
        row.assignment === "subagents");
    respondToConfigurationRequired(rt, 
        (subagents?.declared.length ?? 0) > 0 || subagents?.allowSelf === true
            ? "configured"
            : "cancelled",
    );
}

export function syncConfigurationRequiredRequest(rt: TuiRuntime, 
    request: UiRequestUpdate | undefined,
    target: TuiAgentClient,
): void {
    if (
        request !== undefined
        && isConfigurationRequiredUiRequestUpdate(request)
    ) {
        openConfigurationRequiredRequest(rt, request, target);
        return;
    }
    if (
        rt.activeConfigurationRequest !== undefined
        && rt.activeConfigurationRequest.target === target
    ) {
        rt.activeConfigurationRequest = undefined;
        rt.settingsPicker = undefined;
        closeSettingsPickerSurface(rt);
        openNextConfigurationRequiredRequest(rt);
        return;
    }
    for (let index = rt.queuedConfigurationRequests.length - 1;
        index >= 0; index -= 1) {
        if (rt.queuedConfigurationRequests[index]?.target === target) {
            rt.queuedConfigurationRequests.splice(index, 1);
        }
    }
}


export function requestExtensionSecret(
    rt: TuiRuntime,
    request: { readonly title: string; readonly hint?: string },
    signal: AbortSignal,
): Promise<string | undefined> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (rt.secretPrompt) return Promise.reject(new Error("Another secret entry is already open."));
    return new Promise((resolve) => {
        const finish = (value?: string): void => {
            signal.removeEventListener("abort", abort);
            rt.extensionSecretPrompt = undefined;
            rt.secretPrompt = undefined;
            rt.secretPromptView.clear();
            renderState(rt);
            focusActiveSurface(rt);
            resolve(value);
        };
        const abort = (): void => finish();
        rt.extensionSecretPrompt = finish;
        signal.addEventListener("abort", abort, { once: true });
        rt.secretPrompt = { ...startTuiSecretPrompt({ id: "extension", label: request.title, hint: request.hint }), masked: true, title: request.title };
        rt.composer.blur();
        renderState(rt);
        focusActiveSurface(rt);
    });
}
