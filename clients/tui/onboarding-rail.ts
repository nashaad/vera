/** The line above an onboarding step: the three gate names, and which one the user is on. */

import type { OnboardingStep } from "../../src/providers/onboarding.ts";

const RAIL_GAP = "    ";

/** The position is the marker, so the rail reads with no color. Undefined position means every gate is clear and the rail carries names only. */
export function onboardingRail(
    steps: readonly OnboardingStep[],
    position?: number,
): string {
    const names = steps.map((step) => step.label).join(" > ");
    return position === undefined
        ? names
        : `${names}${RAIL_GAP}step ${position} of ${steps.length}`;
}
