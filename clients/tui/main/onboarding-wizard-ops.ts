/** The wizard's side of the runtime: opening it, moving it a step, and the one real request that closes it. */

import type { AgentUpdate } from "../../../src/engine/protocol.ts";
import { credentialRefusal, holdsCredential } from "../../../src/providers/onboarding.ts";
import { findConfiguredProvider } from "../../../src/providers/registry.ts";
import { loadOptionalVeraConfig } from "../../../src/config.ts";
import { isHomeClient } from "../home-client.ts";
import type { OnboardingScreenAction } from "../onboarding-screen.ts";
import {
    newWizardSession,
    OUTRIDER_REPO,
    RUNTIME_INSTALL_ROW,
    RUNTIME_MANUAL_ROW,
    wizardOpensAt,
    wizardScreen,
    type WizardRuntime,
    type WizardSession,
} from "../onboarding-wizard.ts";
import type { OutriderProgress } from "../../../src/providers/outrider.ts";
import {
    installOutrider,
    mergeProgress,
    outriderPresence,
    serveOutrider,
    type RuntimeCommand,
} from "./outrider-ops.ts";
import { appendTuiError, appendTuiNotice } from "../state.ts";
import { focusedAgentClient, focusedAgentState } from "./agents-dials.ts";
import { requestAgentSettings } from "./diagnostics-ops.ts";
import { focusActiveSurface } from "./focus-switch.ts";
import { onboardingInput } from "./model-pickers.ts";
import { renderState } from "./render-state.ts";
import type { TuiRuntime } from "./runtime.ts";
import { requestPoolAdmission } from "../main.ts";
import { sendCommand } from "./extension-bridge.ts";
import { randomUUID } from "node:crypto";
import {
    beginCreateSession,
    requestModelSettingsChange,
    returnToHome,
} from "./session-ops.ts";

const SPINNER_INTERVAL_MS = 120;

/** The user picked a name off a list, so that name is what they are told about. */
function providerLabel(id: string): string {
    return findConfiguredProvider(id, loadOptionalVeraConfig())?.label ?? id;
}

export function wizardIsOpen(rt: TuiRuntime): boolean {
    return rt.onboardingWizard !== undefined;
}

/** Paints whatever the session now says. Every mutation below ends here. */
export function renderOnboardingWizard(rt: TuiRuntime): void {
    const session = rt.onboardingWizard;
    if (session === undefined) return;
    rt.onboardingWizardView.update(wizardScreen(onboardingInput(rt), session));
    rt.renderer.requestRender();
}

export function updateWizardSession(
    rt: TuiRuntime,
    session: WizardSession,
): void {
    rt.onboardingWizard = session;
    renderOnboardingWizard(rt);
}

/** The wizard takes the terminal, so whatever else was open gives it up. */
function showWizard(rt: TuiRuntime, session: WizardSession): void {
    rt.onboardingWizard = session;
    rt.settingsPicker = undefined;
    rt.secretPrompt = undefined;
    rt.providerForm = undefined;
    rt.composer.blur();
    renderState(rt);
    renderOnboardingWizard(rt);
    focusActiveSurface(rt);
}

export function openOnboardingWizard(rt: TuiRuntime): void {
    const input = onboardingInput(rt);
    const at = wizardOpensAt(input);
    const chosen = at === "provider" ? undefined : input.config?.provider;
    showWizard(rt, {
        ...newWizardSession(at),
        ...(chosen === undefined ? {} : { chosen }),
    });
    if (at === "model" && chosen !== undefined) {
        requestWizardModels(rt, chosen);
    }
}

/** A provider that cleared its own gate somewhere else still owes the user a model, and there is one place that asks for one. */
export function enterWizardModelStep(
    rt: TuiRuntime,
    provider: string,
): void {
    showWizard(rt, { ...newWizardSession("model"), chosen: provider });
    requestWizardModels(rt, provider);
}

export function closeOnboardingWizard(rt: TuiRuntime): void {
    stopWizardSpinner(rt);
    clearRuntimeCommand(rt);
    rt.onboardingWizard = undefined;
    rt.pendingOnboardingStep = undefined;
    renderState(rt);
    focusActiveSurface(rt);
}

function stopWizardSpinner(rt: TuiRuntime): void {
    if (rt.onboardingWizardTimer === undefined) return;
    clearInterval(rt.onboardingWizardTimer);
    rt.onboardingWizardTimer = undefined;
}

const RUNTIME_WORKING = ["checking", "installing", "starting"];

/** The spinner and the elapsed count are the only thing moving while a command or a request is out, so they get their own tick. */
function startWizardSpinner(rt: TuiRuntime): void {
    stopWizardSpinner(rt);
    const startedAt = Date.now();
    rt.onboardingWizardTimer = setInterval(() => {
        const session = rt.onboardingWizard;
        const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
        if (session?.verifying !== undefined) {
            updateWizardSession(rt, {
                ...session,
                spinnerFrame: session.spinnerFrame + 1,
                verifying: { ...session.verifying, elapsedSeconds },
            });
            return;
        }
        if (
            session?.runtime !== undefined
            && RUNTIME_WORKING.includes(session.runtime.state)
        ) {
            updateWizardSession(rt, {
                ...session,
                spinnerFrame: session.spinnerFrame + 1,
                runtime: { ...session.runtime, elapsedSeconds },
            });
            return;
        }
        stopWizardSpinner(rt);
    }, SPINNER_INTERVAL_MS);
}

/** A model list belongs to a conversation, so the wizard opens one and holds the step until its settings arrive. */
function requestWizardModels(rt: TuiRuntime, provider: string): void {
    const session = rt.onboardingWizard;
    // The list is out, so the step says so rather than showing an empty one.
    if (session !== undefined) {
        const { alert: _dropped, ...rest } = session;
        updateWizardSession(rt, { ...rest, asking: true });
    }
    if (!isHomeClient(rt.client)) {
        fillWizardModels(rt, provider);
        askProviderForModels(rt, provider);
        return;
    }
    rt.pendingOnboardingStep = provider;
    beginCreateSession(rt, "stop");
}

/** What the host has saved is what it was told last time, which on a first run is nothing. Every visit to this step asks the provider itself. */
function askProviderForModels(rt: TuiRuntime, provider: string): void {
    const session = rt.onboardingWizard;
    if (session === undefined) return;
    const requestId = randomUUID();
    rt.onboardingCatalogRefresh = requestId;
    const { alert: _dropped, ...rest } = session;
    updateWizardSession(rt, { ...rest, asking: true });
    sendCommand(rt, { type: "catalog_refresh", requestId, provider });
}

/** The provider has answered, so the list stands on its own words. */
export function wizardTookCatalogRefresh(
    rt: TuiRuntime,
    requestId: string,
): boolean {
    if (rt.onboardingCatalogRefresh !== requestId) return false;
    rt.onboardingCatalogRefresh = undefined;
    const session = rt.onboardingWizard;
    if (session === undefined || session.at !== "model") return true;
    const { asking: _answered, ...rest } = session;
    rt.onboardingWizard = rest;
    fillWizardModels(rt, session.chosen ?? "");
    return true;
}

function fillWizardModels(rt: TuiRuntime, provider: string): void {
    const session = rt.onboardingWizard;
    if (session === undefined) return;
    const live = (focusedAgentState(rt).modelSettings?.availableModels ?? [])
        .filter((model) => model.provider === provider)
        .map((model) => ({ id: model.model, label: model.label }));
    // A local gateway lists nothing until it is up, and it does not come up
    // until a profile is picked. The profiles the definition names are what
    // there is to pick from until then.
    const descriptor = findConfiguredProvider(provider, loadOptionalVeraConfig());
    const models = live.length === 0 && descriptor?.localRuntime !== undefined
        ? (descriptor.recommendModels ?? []).map((entry) => ({
            id: entry.id,
            label: entry.id,
        }))
        : live;
    if (models.length === 0) {
        updateWizardSession(rt, {
            ...session,
            at: "model",
            // While the provider is still being asked, an empty list is not
            // yet an answer.
            ...(session.asking === true
                ? {}
                : { alert: `${providerLabel(provider)} listed no models` }),
        });
        return;
    }
    const { alert: _dropped, ...rest } = session;
    updateWizardSession(rt, { ...rest, at: "model", models });
}

/** Called when a conversation reports its models. True when the wizard took them. */
export function wizardTookModelSettings(rt: TuiRuntime): boolean {
    const provider = rt.pendingOnboardingStep;
    if (provider === undefined || rt.onboardingWizard === undefined) {
        return false;
    }
    rt.pendingOnboardingStep = undefined;
    fillWizardModels(rt, provider);
    askProviderForModels(rt, provider);
    return true;
}

function storeKey(rt: TuiRuntime, provider: string, key: string): boolean {
    try {
        rt.authStorage.setCredential(provider, { type: "api_key", key });
        requestAgentSettings(rt, focusedAgentClient(rt));
        return true;
    } catch (error) {
        rt.state = appendTuiError(
            rt.state,
            `could not store the ${provider} API key: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        renderState(rt);
        return false;
    }
}

function chooseProvider(
    rt: TuiRuntime,
    session: WizardSession,
    id: string,
): void {
    const provider = findConfiguredProvider(id, loadOptionalVeraConfig());
    if (provider === undefined) return;
    // Whatever the last provider's runtime was doing is no longer this
    // wizard's business, so the answer is dropped with the step.
    const { alert: _dropped, runtime: _stale, ...rest } = session;
    if (provider.localRuntime !== undefined) {
        updateWizardSession(rt, {
            ...rest,
            chosen: id,
            at: "key",
            selected: undefined,
            runtime: { state: "checking", progress: [] },
        });
        startWizardSpinner(rt);
        void checkRuntime(rt, id);
        return;
    }
    // A key already in the shell or the keychain is an answered gate. Asking
    // for it again leaves nothing to press, since an empty field submits
    // nothing.
    if (
        (provider.credential === "api_key"
            || provider.credential === "api_key_optional")
        && !holdsCredential(provider, onboardingInput(rt))
    ) {
        updateWizardSession(rt, {
            ...rest,
            chosen: id,
            at: "key",
            key: "",
            selected: undefined,
        });
        return;
    }
    updateWizardSession(rt, {
        ...rest,
        chosen: id,
        at: "model",
        selected: undefined,
    });
    requestWizardModels(rt, id);
}

/** Progress arrives a line at a time and only the newest line per file is worth drawing, so the merge happens here rather than in the view. */
function recordRuntimeProgress(rt: TuiRuntime, line: OutriderProgress): void {
    const session = rt.onboardingWizard;
    const runtime = session?.runtime;
    if (session === undefined || runtime === undefined) return;
    updateWizardSession(rt, {
        ...session,
        runtime: {
            ...runtime,
            progress: mergeProgress(runtime.progress, line),
        },
    });
}

function clearRuntimeCommand(rt: TuiRuntime): void {
    rt.onboardingRuntimeCommand?.stop();
    rt.onboardingRuntimeCommand = undefined;
}

/** Present means the binary is here, not that a gateway is up: bringing one up needs a profile, which is the next step's question. */
function runtimeIsPresent(
    rt: TuiRuntime,
    session: WizardSession,
    provider: string,
): void {
    const { alert: _dropped, ...rest } = session;
    updateWizardSession(rt, {
        ...rest,
        at: "model",
        selected: undefined,
        runtime: { state: "present", progress: [] },
    });
    requestWizardModels(rt, provider);
}

async function checkRuntime(rt: TuiRuntime, provider: string): Promise<void> {
    const presence = await outriderPresence();
    const session = rt.onboardingWizard;
    if (session === undefined || session.chosen !== provider) return;
    if (session.runtime?.state !== "checking") return;
    stopWizardSpinner(rt);
    if (presence.state === "absent") {
        updateWizardSession(rt, {
            ...session,
            runtime: { state: "absent", progress: [] },
        });
        return;
    }
    runtimeIsPresent(rt, session, provider);
}

function installRuntime(
    rt: TuiRuntime,
    session: WizardSession,
    provider: string,
): void {
    const { alert: _dropped, ...rest } = session;
    updateWizardSession(rt, {
        ...rest,
        runtime: { state: "installing", progress: [] },
    });
    startWizardSpinner(rt);
    rt.onboardingRuntimeCommand = installOutrider((line) => {
        recordRuntimeProgress(rt, line);
    });
    const command = rt.onboardingRuntimeCommand;
    void command.finished.then(async (result) => {
        if (rt.onboardingRuntimeCommand !== command) return;
        rt.onboardingRuntimeCommand = undefined;
        const live = rt.onboardingWizard;
        if (live === undefined || live.runtime?.state !== "installing") return;
        if (!result.ok) {
            stopWizardSpinner(rt);
            updateWizardSession(rt, {
                ...live,
                runtime: { state: "absent", progress: [] },
                alert: `could not install Outrider${
                    result.detail === "" ? "" : `: ${result.detail}`
                }`,
            });
            return;
        }
        updateWizardSession(rt, {
            ...live,
            runtime: { state: "checking", progress: [] },
        });
        await checkRuntime(rt, provider);
    });
}

/** A local profile is not reachable until it is fetched and up, so the model step starts it before the same gate every other provider passes. */
function startRuntimeProfile(
    rt: TuiRuntime,
    session: WizardSession,
    provider: string,
    profile: string,
): void {
    const { alert: _dropped, ...rest } = session;
    updateWizardSession(rt, {
        ...rest,
        selected: profile,
        runtime: { state: "starting", progress: [] },
    });
    startWizardSpinner(rt);
    rt.onboardingRuntimeCommand = serveOutrider(profile, (line) => {
        recordRuntimeProgress(rt, line);
    });
    const command = rt.onboardingRuntimeCommand;
    void command.finished.then((result) => {
        if (rt.onboardingRuntimeCommand !== command) return;
        rt.onboardingRuntimeCommand = undefined;
        const live = rt.onboardingWizard;
        if (live === undefined || live.runtime?.state !== "starting") return;
        stopWizardSpinner(rt);
        const settled: WizardSession = {
            ...live,
            runtime: { state: "present", progress: [] },
        };
        if (!result.ok) {
            updateWizardSession(rt, {
                ...settled,
                alert: `${profile} did not start${
                    result.detail === "" ? "" : `: ${result.detail}`
                }`,
            });
            return;
        }
        beginWizardVerification(rt, settled, provider, profile);
    });
}

/** The user says they will put the binary there themselves, so the wizard gets out of the way and leaves the address behind. */
function leaveRuntimeToTheUser(rt: TuiRuntime): void {
    closeOnboardingWizard(rt);
    rt.state = appendTuiNotice(
        rt.state,
        `install Outrider from ${OUTRIDER_REPO}, then pick Connect a provider again`,
    );
    renderState(rt);
    if (!isHomeClient(rt.client)) returnToHome(rt);
}

function beginWizardVerification(
    rt: TuiRuntime,
    session: WizardSession,
    provider: string,
    model: string,
): void {
    const requestId = requestPoolAdmission(rt, provider, model, true);
    rt.onboardingVerification = { requestId, provider, model };
    updateWizardSession(rt, {
        ...session,
        verifying: {
            model,
            elapsedSeconds: 0,
            reachable: false,
            answered: false,
        },
    });
    startWizardSpinner(rt);
}

/** One step back, and the answer that step held is dropped so it is asked again. */
function stepBack(rt: TuiRuntime, session: WizardSession): void {
    const { alert: _dropped, runtime: _stale, ...rest } = session;
    if (session.at === "model") {
        const provider = findConfiguredProvider(
            session.chosen ?? "",
            loadOptionalVeraConfig(),
        );
        if (provider !== undefined && provider.credential !== "none") {
            updateWizardSession(rt, { ...rest, at: "key", selected: undefined });
            return;
        }
        updateWizardSession(rt, {
            ...rest,
            at: "provider",
            chosen: undefined,
            selected: undefined,
        });
        return;
    }
    updateWizardSession(rt, {
        ...rest,
        at: "provider",
        chosen: undefined,
        key: "",
        selected: undefined,
    });
}

export function runOnboardingWizardAction(
    rt: TuiRuntime,
    action: OnboardingScreenAction,
): void {
    const session = rt.onboardingWizard;
    if (session === undefined) return;
    if (action.kind === "leave") {
        closeOnboardingWizard(rt);
        if (!isHomeClient(rt.client)) returnToHome(rt);
        return;
    }
    const runtime = session.runtime;
    if (runtime !== undefined && runtime.state !== "checking") {
        // A command in flight owns the screen, and the only key it offers is
        // the one that stops it.
        if (runtime.state === "installing" || runtime.state === "starting") {
            clearRuntimeCommand(rt);
            stopWizardSpinner(rt);
            updateWizardSession(rt, {
                ...session,
                runtime: {
                    state: runtime.state === "installing" ? "absent" : "present",
                    progress: [],
                },
            });
            return;
        }
        if (runtime.state === "absent" && action.kind === "choose") {
            if (action.id === RUNTIME_INSTALL_ROW) {
                installRuntime(rt, session, session.chosen ?? "");
            } else if (action.id === RUNTIME_MANUAL_ROW) {
                leaveRuntimeToTheUser(rt);
            }
            return;
        }
    }
    if (session.verifying !== undefined) {
        // The only key the verify screen offers is the one that abandons it.
        stopWizardSpinner(rt);
        rt.onboardingVerification = undefined;
        const { verifying: _dropped, ...rest } = session;
        updateWizardSession(rt, rest);
        return;
    }
    if (session.connected !== undefined) {
        closeOnboardingWizard(rt);
        return;
    }
    if (action.kind === "back") {
        stepBack(rt, session);
        return;
    }
    if (action.kind === "submit") {
        const provider = session.chosen;
        if (provider === undefined || action.value === "") return;
        if (!storeKey(rt, provider, action.value)) return;
        rt.state = appendTuiNotice(rt.state, `stored ${provider} API key`);
        const { alert: _dropped, ...rest } = session;
        updateWizardSession(rt, { ...rest, at: "model" });
        requestWizardModels(rt, provider);
        return;
    }
    if (action.kind !== "choose") return;
    if (session.at === "provider") {
        chooseProvider(rt, session, action.id);
        return;
    }
    if (session.at === "model" && session.chosen !== undefined) {
        if (runtime !== undefined) {
            startRuntimeProfile(rt, session, session.chosen, action.id);
            return;
        }
        beginWizardVerification(rt, session, session.chosen, action.id);
    }
}

/** The gate closes on an answer, not on a stored key. A refusal is about the credential, so it sends the user one step back with the provider's own words. */
export function settleWizardVerification(
    rt: TuiRuntime,
    update: Extract<AgentUpdate, { type: "pool_admission_result" }>,
): boolean {
    const session = rt.onboardingWizard;
    const pending = rt.onboardingVerification;
    if (
        session === undefined || pending === undefined
        || pending.requestId !== update.requestId
    ) {
        return false;
    }
    rt.onboardingVerification = undefined;
    stopWizardSpinner(rt);
    const { verifying: _dropped, ...rest } = session;
    const refusal = credentialRefusal(update);
    if (refusal !== undefined) {
        updateWizardSession(rt, {
            ...rest,
            at: "key",
            key: "",
            alert: `${providerLabel(pending.provider)} refused that key: ${
                refusal
            }`,
        });
        return true;
    }
    if (update.verdict !== "added") {
        updateWizardSession(rt, {
            ...rest,
            alert: `${pending.model} did not answer${
                update.reason === undefined ? "" : `: ${update.reason}`
            }`,
        });
        return true;
    }
    // The model step is the user picking their first model, so the answer
    // becomes the default rather than leaving them pointed at whatever the
    // factory home shipped.
    const modelRequest = requestModelSettingsChange(
        rt,
        { provider: pending.provider, model: pending.model },
        `model → ${pending.provider}/${pending.model}`,
        `the model to ${pending.provider}/${pending.model}`,
    );
    if (rt.onboardingPromptWaiting) {
        rt.onboardingPromptRequest = modelRequest;
    }
    updateWizardSession(rt, { ...rest, connected: pending.model });
    return true;
}
