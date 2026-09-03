/** The client's side of the last gate: the conversation the model step needs, the one real request, and the line that closes the flow. */

import type { AgentUpdate } from "../../../src/engine/protocol.ts";
import { credentialRefusal } from "../../../src/providers/onboarding.ts";
import { isHomeClient } from "../home-client.ts";
import { requestPoolAdmission } from "../main.ts";
import { appendTuiNotice } from "../state.ts";
import { focusActiveSurface } from "./focus-switch.ts";
import { connectProvider, openOnboardingModelStep } from "./model-pickers.ts";
import {
    settleWizardVerification,
    wizardTookModelSettings,
} from "./onboarding-wizard-ops.ts";
import { renderState } from "./render-state.ts";
import type { TuiRuntime } from "./runtime.ts";
import {
    beginCreateSession,
    requestModelSettingsChange,
} from "./session-ops.ts";

/** A model list belongs to a conversation, so the flow opens one and holds the step until its settings arrive. */
export function enterOnboardingModelStep(
    rt: TuiRuntime,
    provider: string,
): void {
    if (!isHomeClient(rt.client)) {
        openOnboardingModelStep(rt, provider);
        return;
    }
    rt.pendingOnboardingStep = provider;
    beginCreateSession(rt, "stop");
}

/** The step opens once the new conversation says what models it has. */
export function openPendingOnboardingStep(rt: TuiRuntime): boolean {
    if (wizardTookModelSettings(rt)) {
        return true;
    }
    const provider = rt.pendingOnboardingStep;
    if (provider === undefined) {
        return false;
    }
    rt.pendingOnboardingStep = undefined;
    openOnboardingModelStep(rt, provider);
    return true;
}

export function beginOnboardingVerification(
    rt: TuiRuntime,
    provider: string,
    model: string,
): void {
    rt.settingsPicker = undefined;
    const requestId = requestPoolAdmission(rt, provider, model, true);
    rt.onboardingVerification = { requestId, provider, model };
    renderState(rt);
    focusActiveSurface(rt);
}

/** The gate closes on an answer, not on a stored key. A verdict short of `added` leaves the step open so another model can be tried. */
export function settleOnboardingVerification(
    rt: TuiRuntime,
    update: Extract<AgentUpdate, { type: "pool_admission_result" }>,
): boolean {
    if (settleWizardVerification(rt, update)) {
        return true;
    }
    const pending = rt.onboardingVerification;
    if (pending === undefined || pending.requestId !== update.requestId) {
        return false;
    }
    rt.onboardingVerification = undefined;
    const refusal = credentialRefusal(update);
    if (refusal !== undefined) {
        // The credential, not the model. The fix is one gate back.
        connectProvider(rt, pending.provider, undefined, refusal);
        return true;
    }
    if (update.verdict !== "added") {
        openOnboardingModelStep(rt, pending.provider);
        return true;
    }
    rt.state = appendTuiNotice(
        rt.state,
        `${pending.provider} answered on ${pending.model}`,
    );
    // The model step is the user picking their first model, so the answer
    // becomes the default rather than leaving them pointed at whatever the
    // factory home shipped. Only this flow does it: a later verify from the
    // model picker is a question about a model, not a choice of one.
    const modelRequest = requestModelSettingsChange(
        rt,
        { provider: pending.provider, model: pending.model },
        `model → ${pending.provider}/${pending.model}`,
        `the model to ${pending.provider}/${pending.model}`,
    );
    // The prompt is already in the composer. It waits for the model change to
    // land, because sending it now would run it on the model the flow just
    // replaced.
    if (rt.onboardingPromptWaiting) {
        rt.onboardingPromptRequest = modelRequest;
    }
    renderState(rt);
    focusActiveSurface(rt);
    return true;
}

