import { describe, expect, test } from "bun:test";

import {
    handleOnboardingKey,
    onboardingCardLines,
    ONBOARDING_CARD_COLUMNS,
    selectableRows,
    type OnboardingScreenState,
} from "../../clients/tui/onboarding-screen.ts";
import type {
    OnboardingStep,
    OnboardingStepState,
} from "../../src/providers/onboarding.ts";

const steps = (
    provider: OnboardingStepState,
    key: OnboardingStepState,
    model: OnboardingStepState,
): readonly OnboardingStep[] => [
    { id: "provider", label: "Provider", state: provider },
    { id: "key", label: "Key", state: key },
    { id: "model", label: "Model", state: model },
];

const rendered = (state: OnboardingScreenState): string =>
    onboardingCardLines(state).map((line) => line.text).join("\n");

const providerStep: OnboardingScreenState = {
    steps: steps("current", "locked", "locked"),
    answers: {},
    heading: "Who runs your models?",
    selected: "openrouter",
    body: {
        kind: "choice",
        groups: [
            {
                label: "RECOMMENDED",
                rows: [
                    {
                        id: "openrouter",
                        label: "OpenRouter",
                        detail: "one key, most models, pay as you go",
                    },
                    {
                        id: "outrider",
                        label: "Outrider",
                        detail: "runs on this Mac, no key, no account",
                    },
                ],
            },
            {
                label: "OTHER",
                rows: [
                    {
                        id: "ollama",
                        label: "Ollama",
                        detail: "runs on this Mac, no key",
                    },
                ],
            },
        ],
    },
};

const keyStep: OnboardingScreenState = {
    steps: steps("done", "current", "locked"),
    answers: { provider: { text: "OpenRouter" } },
    heading: "Paste your OpenRouter key.",
    body: {
        kind: "secret",
        value: "",
        placeholder: "sk-or-v1-",
        notes: ["Kept in your keychain. Only ever sent to OpenRouter."],
    },
};

describe("the setup screen", () => {
    test("names all three gates, marks the one you are on, and groups the choices", () => {
        expect(rendered(providerStep)).toBe(
            [
                "┌ Set up Vera ─────────────────────────────────────────────────────────┐",
                "│                                                                      │",
                "│  1 ▸ Provider          2   Key               3   Model               │",
                "│  ────────────          ·······               ·········               │",
                "│                                                                      │",
                "│  Who runs your models?                                               │",
                "│                                                                      │",
                "│  RECOMMENDED                                                         │",
                "│    › OpenRouter  one key, most models, pay as you go                 │",
                "│      Outrider    runs on this Mac, no key, no account                │",
                "│                                                                      │",
                "│  OTHER                                                               │",
                "│      Ollama      runs on this Mac, no key                            │",
                "│                                                                      │",
                "│  ↑↓ choose    enter next    esc leave setup                          │",
                "└──────────────────────────────────────────────────────────────────────┘",
            ].join("\n"),
        );
    });

    test("a finished gate keeps its answer, so the screen is also a summary", () => {
        expect(rendered(keyStep)).toContain("│  ✓   Provider          2 ▸ Key");
        expect(rendered(keyStep)).toContain("│      OpenRouter        ───────");
    });

    test("a gate that did not apply reads as settled, not hidden", () => {
        const skipped: OnboardingScreenState = {
            ...keyStep,
            steps: steps("done", "done", "current"),
            answers: {
                provider: { text: "Outrider" },
                key: { text: "not needed", skipped: true },
            },
            heading: "What should Vera run?",
            body: { kind: "choice", groups: [] },
        };
        expect(rendered(skipped)).toContain("–   Key");
        expect(rendered(skipped)).toContain("not needed");
    });

    test("every state is legible with no color at all", () => {
        const marks = rendered({
            ...keyStep,
            steps: steps("done", "done", "current"),
            answers: {
                provider: { text: "Outrider" },
                key: { text: "not needed", skipped: true },
            },
        });
        for (const marker of ["✓", "–", "▸"]) {
            expect(marks).toContain(marker);
        }
        expect(rendered(providerStep)).toContain("› OpenRouter");
    });

    test("a refusal shows the provider's own words above the field", () => {
        const refused: OnboardingScreenState = {
            ...keyStep,
            alert: "no auth credentials found",
        };
        expect(rendered(refused)).toContain("! no auth credentials found");
    });

    test("nothing can push the frame open", () => {
        const long = "x".repeat(400);
        const wide: OnboardingScreenState = {
            ...providerStep,
            heading: long,
            body: {
                kind: "choice",
                groups: [{ rows: [{ id: "a", label: long, detail: long }] }],
            },
        };
        for (const line of onboardingCardLines(wide)) {
            expect([...line.text].length).toBe(ONBOARDING_CARD_COLUMNS);
        }
    });
});

describe("moving through the setup screen", () => {
    test("escape leaves from the first gate and goes back from any later one", () => {
        expect(handleOnboardingKey(providerStep, { name: "escape" }).action)
            .toEqual({ kind: "leave" });
        expect(handleOnboardingKey(keyStep, { name: "escape" }).action)
            .toEqual({ kind: "back" });
    });

    test("the footer says which of the two escape does", () => {
        expect(rendered(providerStep)).toContain("esc leave setup");
        expect(rendered(keyStep)).toContain("esc back");
    });

    test("the caret wraps and enter chooses what it is on", () => {
        const down = handleOnboardingKey(providerStep, { name: "down" }).state;
        expect(down?.selected).toBe("outrider");
        expect(handleOnboardingKey(providerStep, { name: "return" }).action)
            .toEqual({ kind: "choose", id: "openrouter" });
    });

    test("a row shown for why it cannot be picked is skipped by the caret", () => {
        const withBlocked: OnboardingScreenState = {
            ...providerStep,
            selected: "ok",
            body: {
                kind: "choice",
                groups: [{
                    rows: [
                        { id: "ok", label: "Fits" },
                        {
                            id: "too-big",
                            label: "Too big",
                            unavailable: "needs 32 GB",
                        },
                    ],
                }],
            },
        };
        expect(selectableRows(withBlocked.body).map((row) => row.id))
            .toEqual(["ok"]);
        expect(handleOnboardingKey(withBlocked, { name: "down" }).state?.selected)
            .toBe("ok");
        expect(rendered(withBlocked)).toContain("needs 32 GB");
    });

    test("the key field takes typing, backspace, and enter", () => {
        const typed = handleOnboardingKey(keyStep, {
            name: "k",
            sequence: "k",
        }).state;
        expect(typed?.body.kind === "secret" && typed.body.value).toBe("k");
        expect(rendered(typed ?? keyStep)).toContain("sk-or-v1-•");
        const back = handleOnboardingKey(typed ?? keyStep, {
            name: "backspace",
        }).state;
        expect(back?.body.kind === "secret" && back.body.value).toBe("");
        const sent = handleOnboardingKey(typed ?? keyStep, { name: "return" });
        expect(sent.action).toEqual({ kind: "submit", value: "k" });
    });

    test("the key is never drawn back to the screen", () => {
        const typed = handleOnboardingKey(keyStep, {
            name: "s",
            sequence: "s",
        }).state;
        expect(rendered(typed ?? keyStep)).not.toContain("sk-or-v1-s");
    });

    test("a long list filters as you type", () => {
        const searching: OnboardingScreenState = {
            ...providerStep,
            body: { ...providerStep.body, query: "" } as OnboardingScreenState[
                "body"
            ],
        };
        const typed = handleOnboardingKey(searching, {
            name: "o",
            sequence: "o",
        }).state;
        const shown = rendered(typed ?? searching);
        expect(shown).toContain("OpenRouter");
        expect(shown).toContain("Outrider");
        expect(shown).toContain("Ollama");
        const narrowed = handleOnboardingKey(typed ?? searching, {
            name: "l",
            sequence: "l",
        }).state;
        expect(rendered(narrowed ?? searching)).not.toContain("OpenRouter");
    });

    test("what you have typed is on the screen, not just in the filter", () => {
        const searching: OnboardingScreenState = {
            ...providerStep,
            body: { ...providerStep.body, query: "" } as OnboardingScreenState[
                "body"
            ],
        };
        expect(rendered(searching)).toContain("type to search");
        const typed = handleOnboardingKey(searching, {
            name: "o",
            sequence: "o",
        }).state;
        expect(rendered(typed ?? searching)).toContain("/ o");
    });

    test("a list longer than the window scrolls, and says what is outside", () => {
        const many: OnboardingScreenState = {
            ...providerStep,
            selected: "model-0",
            body: {
                kind: "choice",
                groups: [
                    {
                        label: "MODELS",
                        rows: Array.from({ length: 40 }, (_row, index) => ({
                            id: `model-${index}`,
                            label: `Model ${index}`,
                        })),
                    },
                ],
            },
        };
        const top = rendered(many);
        expect(top).toContain("Model 0");
        expect(top).toContain("Model 9");
        expect(top).not.toContain("Model 10");
        expect(top).toContain("30 more below");
        expect(top).not.toContain("more above");
        expect(onboardingCardLines(many).length).toBeLessThanOrEqual(24);
        const deeper = rendered({ ...many, selected: "model-39" });
        expect(deeper).toContain("Model 39");
        expect(deeper).toContain("30 more above");
        expect(deeper).not.toContain("more below");
    });
});
