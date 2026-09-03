/** The wizard's side of the runtime: opening it, moving it a step, and the one real request that closes it. */

import type { AgentUpdate } from "../../../src/engine/protocol.ts";
import { credentialRefusal } from "../../../src/providers/onboarding.ts";
import { findConfiguredProvider } from "../../../src/providers/registry.ts";
import { loadOptionalVeraConfig } from "../../../src/config.ts";
import { isHomeClient } from "../home-client.ts";
import type { OnboardingScreenAction } from "../onboarding-screen.ts";
import {
    newWizardSession,
    wizardOpensAt,
    wizardScreen,
    type WizardSession,
} from "../onboarding-wizard.ts";
import { appendTuiError, appendTuiNotice } from "../state.ts";
import { focusedAgentClient, focusedAgentState } from "./agents-dials.ts";
import { requestAgentSettings } from "./diagnostics-ops.ts";
import { focusActiveSurface } from "./focus-switch.ts";
import { onboardingInput } from "./model-pickers.ts";
import { renderState } from "./render-state.ts";
import type { TuiRuntime } from "./runtime.ts";
import { requestPoolAdmission } from "../main.ts";
import {
    beginCreateSession,
    requestModelSettingsChange,
    returnToHome,
} from "./session-ops.ts";

const SPINNER_INTERVAL_MS = 120;

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

export function openOnboardingWizard(rt: TuiRuntime): void {
    const input = onboardingInput(rt);
    const at = wizardOpensAt(input);
    const chosen = at === "provider" ? undefined : input.config?.provider;
    rt.onboardingWizard = {
        ...newWizardSession(at),
        ...(chosen === undefined ? {} : { chosen }),
    };
    rt.settingsPicker = undefined;
    rt.secretPrompt = undefined;
    rt.composer.blur();
    renderState(rt);
    renderOnboardingWizard(rt);
    focusActiveSurface(rt);
    if (at === "model" && chosen !== undefined) {
        requestWizardModels(rt, chosen);
    }
}

export function closeOnboardingWizard(rt: TuiRuntime): void {
    stopWizardSpinner(rt);
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

/** The spinner and the elapsed count are the only thing moving while a request is out, so they get their own tick. */
function startWizardSpinner(rt: TuiRuntime): void {
    stopWizardSpinner(rt);
    const startedAt = Date.now();
    rt.onboardingWizardTimer = setInterval(() => {
        const session = rt.onboardingWizard;
        if (session?.verifying === undefined) {
            stopWizardSpinner(rt);
            return;
        }
        updateWizardSession(rt, {
            ...session,
            spinnerFrame: session.spinnerFrame + 1,
            verifying: {
                ...session.verifying,
                elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
            },
        });
    }, SPINNER_INTERVAL_MS);
}

/** A model list belongs to a conversation, so the wizard opens one and holds the step until its settings arrive. */
function requestWizardModels(rt: TuiRuntime, provider: string): void {
    if (!isHomeClient(rt.client)) {
        fillWizardModels(rt, provider);
        return;
    }
    rt.pendingOnboardingStep = provider;
    beginCreateSession(rt, "stop");
}

function fillWizardModels(rt: TuiRuntime, provider: string): void {
    const session = rt.onboardingWizard;
    if (session === undefined) return;
    const models = (focusedAgentState(rt).modelSettings?.availableModels ?? [])
        .filter((model) => model.provider === provider)
        .map((model) => ({ id: model.model, label: model.label }));
    if (models.length === 0) {
        updateWizardSession(rt, {
            ...session,
            at: "model",
            alert: `${provider} listed no models`,
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
    const { alert: _dropped, ...rest } = session;
    if (
        provider.credential === "api_key"
        || provider.credential === "api_key_optional"
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
    const { alert: _dropped, ...rest } = session;
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
            alert: `${pending.provider} refused that key: ${refusal}`,
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
