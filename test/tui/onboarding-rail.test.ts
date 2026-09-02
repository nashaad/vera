import { expect, test } from "bun:test";

import { onboardingRail } from "../../clients/tui/onboarding-rail.ts";
import type { OnboardingStep } from "../../src/providers/onboarding.ts";

const STEPS: readonly OnboardingStep[] = [
    { id: "provider", label: "Provider", state: "done" },
    { id: "key", label: "Key", state: "current" },
    { id: "model", label: "Model", state: "locked" },
];

test("the rail names the gates and says which one the user is on", () => {
    // The position is the marker, so the line survives a monochrome terminal.
    expect(onboardingRail(STEPS, 2)).toBe(
        "Provider > Key > Model    step 2 of 3",
    );
});

test("a cleared flow leaves the rail as names alone", () => {
    expect(onboardingRail(STEPS)).toBe("Provider > Key > Model");
});
