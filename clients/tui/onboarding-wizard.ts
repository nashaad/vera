/** The wizard's own state, and the screen it makes. Everything here is pure, so the whole flow can be walked in a test without a terminal. */

import {
    currentStep,
    stepperSteps,
    type OnboardingInput,
    type OnboardingStep,
    type OnboardingStepId,
} from "../../src/providers/onboarding.ts";
import {
    machineFacts,
    recommendedProviders,
    type MachineFacts,
} from "../../src/providers/recommendation.ts";
import type { RecommendedModel } from "../../src/providers/definitions.ts";
import type { ProviderDescriptor } from "../../src/providers/registry.ts";
import {
    handleOnboardingKey,
    type OnboardingAnswer,
    type OnboardingChoiceGroup,
    type OnboardingChoiceRow,
    type OnboardingKey,
    type OnboardingScreenAction,
    type OnboardingScreenState,
} from "./onboarding-screen.ts";

export interface WizardModel {
    readonly id: string;
    readonly label: string;
}

/** What the model step is waiting on. Verification is a request in flight, not a stored fact, so it lives here rather than in the pool. */
export interface WizardVerification {
    readonly model: string;
    readonly elapsedSeconds: number;
    readonly reachable: boolean;
    readonly answered: boolean;
}

/** Everything the user has done in this run of the wizard. The stored facts say what is true; this says where they are. */
export interface WizardSession {
    readonly at: OnboardingStepId;
    readonly chosen?: string;
    readonly key: string;
    readonly query: string;
    readonly selected?: string;
    /** The provider's own words when it refused. */
    readonly alert?: string;
    readonly verifying?: WizardVerification;
    /** The model that answered, which closes the flow. */
    readonly connected?: string;
    readonly models: readonly WizardModel[];
    readonly spinnerFrame: number;
}

export function newWizardSession(at: OnboardingStepId): WizardSession {
    return { at, key: "", query: "", models: [], spinnerFrame: 0 };
}

/** The step the stored facts open on, so a half-finished install resumes where it stopped. */
export function wizardOpensAt(input: OnboardingInput): OnboardingStepId {
    return currentStep(input) ?? "provider";
}

function chosenProvider(
    input: OnboardingInput,
    session: WizardSession,
): ProviderDescriptor | undefined {
    return input.providers.find((provider) => provider.id === session.chosen);
}

/** What the second gate is called for this provider. A provider that needs no key still has a second gate; it is just named after what it does need. */
function keyStepLabel(provider: ProviderDescriptor | undefined): string {
    if (provider === undefined) return "Key";
    return provider.credential === "none" ? "Setup" : "Key";
}

function relabel(
    steps: readonly OnboardingStep[],
    provider: ProviderDescriptor | undefined,
): readonly OnboardingStep[] {
    return steps.map((step) =>
        step.id === "key" ? { ...step, label: keyStepLabel(provider) } : step
    );
}

/** A model that answered inside this run clears the last gate. The pool file agrees, but it is reloaded later, and the spine must not lag behind what the user just watched happen. */
function settleModelStep(
    steps: readonly OnboardingStep[],
): readonly OnboardingStep[] {
    return steps.map((step) =>
        step.id === "model" ? { ...step, state: "done" } : step
    );
}

function answersFor(
    input: OnboardingInput,
    session: WizardSession,
): Partial<Record<OnboardingStepId, OnboardingAnswer>> {
    const provider = chosenProvider(input, session);
    const answers: Partial<Record<OnboardingStepId, OnboardingAnswer>> = {};
    if (provider !== undefined) {
        answers.provider = { text: provider.label };
        if (provider.credential === "none") {
            answers.key = { text: "not needed", skipped: true };
        } else if (session.key !== "" || session.at === "model") {
            answers.key = { text: "stored" };
        }
    }
    if (session.connected !== undefined) {
        answers.model = { text: session.connected };
    }
    return answers;
}

function providerRow(
    provider: ProviderDescriptor,
    detail: string,
): OnboardingChoiceRow {
    return {
        id: provider.id,
        label: provider.label,
        ...(detail === "" ? {} : { detail }),
    };
}

/** Recommended first with the reason the definition gives, then everything else with its own hint. */
export function providerGroups(
    providers: readonly ProviderDescriptor[],
    machine: MachineFacts,
): readonly OnboardingChoiceGroup[] {
    const recommended = recommendedProviders(providers, machine);
    const promoted = new Set(recommended.map((entry) => entry.provider.id));
    const rest = providers.filter((provider) => !promoted.has(provider.id));
    const groups: OnboardingChoiceGroup[] = [];
    if (recommended.length !== 0) {
        groups.push({
            label: "RECOMMENDED",
            rows: recommended.map((entry) =>
                providerRow(entry.provider, entry.reason)
            ),
        });
    }
    if (rest.length !== 0) {
        groups.push({
            label: recommended.length === 0 ? undefined : "OTHER",
            rows: rest.map((provider) =>
                providerRow(provider, provider.hint ?? "")
            ),
        });
    }
    return groups;
}

/** Long enough that scanning it by eye stops working. */
const SEARCHABLE_FROM = 12;

function modelRow(model: WizardModel): OnboardingChoiceRow {
    return {
        id: model.id,
        label: model.label,
        ...(model.label === model.id ? {} : { detail: model.id }),
    };
}

/** A recommendation names a job rather than a model, so the row reads as the job and the model id becomes the detail. */
function recommendedModelRow(
    recommended: RecommendedModel,
    model: WizardModel,
): OnboardingChoiceRow {
    return {
        id: model.id,
        label: recommended.label,
        detail: model.id,
        note: recommended.reason,
    };
}

/** Recommended jobs first, then the rest. A recommendation for a model this provider does not list is dropped rather than offered. */
function modelGroups(
    provider: ProviderDescriptor | undefined,
    session: WizardSession,
): readonly OnboardingChoiceGroup[] {
    const recommended = [...provider?.recommendModels ?? []]
        .sort((left, right) => left.rank - right.rank)
        .flatMap((entry) => {
            const model = session.models.find((row) => row.id === entry.id);
            return model === undefined ? [] : [recommendedModelRow(entry, model)];
        });
    const promoted = new Set(recommended.map((row) => row.id));
    const rest = session.models.filter((model) => !promoted.has(model.id));
    if (recommended.length === 0) return [{ rows: rest.map(modelRow) }];
    const groups: OnboardingChoiceGroup[] = [
        { label: "RECOMMENDED", rows: recommended },
    ];
    if (rest.length !== 0) {
        groups.push({ label: "OTHER", rows: rest.map(modelRow) });
    }
    return groups;
}

function keyNotes(provider: ProviderDescriptor): readonly string[] {
    return [
        `Kept in your keychain. Only ever sent to ${provider.label}.`,
        ...(provider.envVar === undefined
            ? []
            : [`Or set ${provider.envVar} in your shell.`]),
    ];
}

function verifyChecks(verifying: WizardVerification) {
    return [
        {
            label: "reachable",
            state: verifying.reachable ? "done" as const : "active" as const,
        },
        {
            label: "answered",
            state: verifying.answered
                ? "done" as const
                : verifying.reachable
                ? "active" as const
                : "pending" as const,
        },
    ];
}

export function wizardScreen(
    input: OnboardingInput,
    session: WizardSession,
    machine: MachineFacts = machineFacts(),
): OnboardingScreenState {
    const provider = chosenProvider(input, session);
    const walked = relabel(
        stepperSteps({ ...input, chosen: session.chosen, at: session.at }),
        provider,
    );
    const steps = session.connected === undefined
        ? walked
        : settleModelStep(walked);
    const common = {
        steps,
        answers: answersFor(input, session),
        ...(session.alert === undefined ? {} : { alert: session.alert }),
        ...(session.selected === undefined ? {} : { selected: session.selected }),
        spinnerFrame: session.spinnerFrame,
    };
    if (session.connected !== undefined) {
        return {
            ...common,
            heading: "",
            body: {
                kind: "done",
                lines: [`Connected. ${session.connected} is your default now.`],
            },
        };
    }
    if (session.verifying !== undefined) {
        return {
            ...common,
            heading: "",
            body: {
                kind: "progress",
                label: `Asking ${session.verifying.model} to say hello`,
                elapsedSeconds: session.verifying.elapsedSeconds,
                checks: verifyChecks(session.verifying),
                escHint: "esc pick a different model",
            },
        };
    }
    if (session.at === "key" && provider !== undefined) {
        return {
            ...common,
            heading: `Paste your ${provider.label} key.`,
            body: {
                kind: "secret",
                value: session.key,
                placeholder: "",
                notes: keyNotes(provider),
            },
        };
    }
    if (session.at === "model") {
        return {
            ...common,
            heading: "What should Vera run?",
            body: {
                kind: "choice",
                groups: modelGroups(provider, session),
                enterHint: "connect",
                ...(session.models.length >= SEARCHABLE_FROM
                    ? { query: session.query }
                    : {}),
            },
        };
    }
    return {
        ...common,
        heading: "Who runs your models?",
        body: {
            kind: "choice",
            groups: providerGroups(input.providers, machine),
        },
    };
}

export interface WizardKeyResult {
    readonly session?: WizardSession;
    readonly action?: OnboardingScreenAction;
    readonly handled: boolean;
}

/** The screen edits its own state; this puts those edits back where the wizard keeps them. */
function sessionFrom(
    session: WizardSession,
    state: OnboardingScreenState,
): WizardSession {
    const body = state.body;
    return {
        ...session,
        selected: state.selected,
        ...(body.kind === "secret" ? { key: body.value } : {}),
        ...(body.kind === "choice" && body.query !== undefined
            ? { query: body.query }
            : {}),
    };
}

export function handleWizardKey(
    input: OnboardingInput,
    session: WizardSession,
    key: OnboardingKey,
    machine?: MachineFacts,
): WizardKeyResult {
    const result = handleOnboardingKey(
        wizardScreen(input, session, machine),
        key,
    );
    return {
        ...(result.state === undefined
            ? {}
            : { session: sessionFrom(session, result.state) }),
        ...(result.action === undefined ? {} : { action: result.action }),
        handled: result.handled,
    };
}
