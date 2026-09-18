/** The status section on the provider screen, and the actions it decides. */

import { describe, expect, test } from "bun:test";
import {
    localRuntimeActions,
    localRuntimeStatusLines,
} from "../../clients/tui/local-runtime-status.ts";
import { localRuntimeStatusOf } from "../../clients/tui/main/outrider-control.ts";
import {
    newWizardSession,
    wizardScreen,
    wizardAdoptsDefault,
} from "../../clients/tui/onboarding-wizard.ts";
import type { OnboardingInput } from "../../src/providers/onboarding.ts";
import { providerActions } from "../../clients/tui/provider-actions.ts";
import type {
    TuiLocalRuntimeStatus,
    TuiSettingsPickerOption,
    TuiSettingsPickerState,
} from "../../clients/tui/settings-picker-types.ts";

const OUTRIDER = { id: "outrider", label: "Outrider" } as const;

function status(patch: Partial<TuiLocalRuntimeStatus> = {}): TuiLocalRuntimeStatus {
    return { provider: "outrider", label: "Outrider", state: "stopped", ...patch };
}

describe("what the section says", () => {
    test("a reading that has not landed says so rather than guessing", () => {
        expect(localRuntimeStatusLines(status({ state: "unknown" }))[1])
            .toBe("Outrider · reading…");
    });

    test("a running model names itself, where it answers, and what it holds", () => {
        expect(localRuntimeStatusLines(status({
            state: "running",
            gateway: "up",
            profile: "ling3-tiny",
            endpoint: "http://127.0.0.1:11435",
            residentBytes: 4_600_000_000,
        }))[1]).toBe(
            "Outrider · serving ling3-tiny · http://127.0.0.1:11435 · 4.6 GB resident",
        );
    });

    test("a gateway with nothing loaded is not the same as stopped", () => {
        expect(localRuntimeStatusLines(status({ gateway: "up" }))[1])
            .toBe("Outrider · gateway up, no model loaded");
        expect(localRuntimeStatusLines(status({ gateway: "down" }))[1])
            .toBe("Outrider · stopped, nothing loaded");
    });

    test("a command in flight is the whole line, so nothing stale reads as settled", () => {
        expect(localRuntimeStatusLines(status({
            state: "running",
            profile: "ling3-tiny",
            busy: "stopping",
        }))[1]).toBe("Outrider · stopping…");
    });

    test("a fetch behind a switch says how far it has got", () => {
        expect(localRuntimeStatusLines(status({
            state: "running",
            busy: "switching",
            progress: { downloaded: 1_200_000_000, total: 2_800_000_000, etaSeconds: 30 },
        }))[1]).toBe("Outrider · switching model… 43% · 1.2 GB / 2.8 GB · ~30 sec");
    });

    test("weights already on disk report no bytes, so the state is the whole line", () => {
        expect(localRuntimeStatusLines(status({ busy: "switching" }))[1])
            .toBe("Outrider · switching model…");
    });

    test("a fetch that has not said how big it is yet claims no percent", () => {
        expect(localRuntimeStatusLines(status({
            busy: "starting",
            progress: { downloaded: 40_000_000 },
        }))[1]).toBe("Outrider · starting…");
    });

    test("a failure stays on the screen that asked for it", () => {
        expect(localRuntimeStatusLines(status({
            failure: "could not start: port 11435 is in use",
        })).at(-1)).toBe("! could not start: port 11435 is in use");
    });
});

describe("what can be asked of it", () => {
    test("a running runtime can be switched, restarted and stopped", () => {
        expect(localRuntimeActions(status({ state: "running" })).map((row) => row.label))
            .toEqual(["Switch model", "Restart", "Stop", "Logs"]);
    });

    test("a stopped runtime is started, not restarted", () => {
        expect(localRuntimeActions(status()).map((row) => row.label))
            .toEqual(["Start", "Switch model", "Logs"]);
    });

    test("nothing is offered while a command is in flight", () => {
        expect(localRuntimeActions(status({ state: "running", busy: "starting" })))
            .toEqual([]);
    });

    test("a runtime that is not installed offers no lifecycle at all", () => {
        expect(localRuntimeActions(status({ state: "absent" }))).toEqual([]);
        expect(localRuntimeActions(undefined)).toEqual([]);
    });
});

describe("the reading behind the section", () => {
    test("a gateway that is up with no model is stopped, not running", () => {
        expect(localRuntimeStatusOf(OUTRIDER as never, {
            gateway: { kind: "running", endpoint: "http://127.0.0.1:11435", healthy: true },
            model: { kind: "stopped" },
        })).toEqual({
            provider: "outrider",
            label: "Outrider",
            state: "stopped",
            gateway: "up",
        });
    });

    test("a served model carries the facts the section shows", () => {
        expect(localRuntimeStatusOf(OUTRIDER as never, {
            gateway: { kind: "running", endpoint: "http://127.0.0.1:11435" },
            model: { kind: "running", profile: "ling3-tiny", healthy: true, residentBytes: 4_600_000_000 },
        })).toEqual({
            provider: "outrider",
            label: "Outrider",
            state: "running",
            gateway: "up",
            profile: "ling3-tiny",
            endpoint: "http://127.0.0.1:11435",
            healthy: true,
            residentBytes: 4_600_000_000,
        });
    });

    test("no binary to ask is absent, which is the wizard's business and not the section's", () => {
        expect(localRuntimeStatusOf(OUTRIDER as never, undefined).state).toBe("absent");
    });
});

describe("the provider row's menu", () => {
    function menu(runtime: TuiLocalRuntimeStatus | undefined): readonly string[] {
        const provider: TuiSettingsPickerOption = {
            value: "outrider",
            label: "Outrider",
            description: "local, no account",
            answerState: "connected",
            localRuntime: true,
            endpointEditable: true,
        };
        const parent: TuiSettingsPickerState = {
            kind: "provider",
            allOptions: [provider],
            options: [provider],
            selectedIndex: 0,
            query: "",
            ...(runtime === undefined ? {} : { localRuntime: runtime }),
        };
        return providerActions(parent, provider).options.map((row) => row.label);
    }

    test("a running local runtime is driven from the row that names it", () => {
        expect(menu(status({ state: "running" })))
            .toEqual(["Edit", "Switch model", "Restart", "Stop", "Logs"]);
    });

    test("a provider screen with no reading yet offers only what it is sure of", () => {
        expect(menu(undefined)).toEqual(["Edit"]);
    });
});

describe("which model the wizard makes the default", () => {
    test("a home with nothing connected adopts whatever answers", () => {
        expect(wizardAdoptsDefault("outrider", true, undefined)).toBe(true);
    });

    test("connecting a second provider leaves the default where it is", () => {
        expect(wizardAdoptsDefault("outrider", false, "openrouter")).toBe(false);
    });

    test("a wizard run against the provider in use is a model change", () => {
        expect(wizardAdoptsDefault("outrider", false, "outrider")).toBe(true);
    });

    test("the provider step has no provider yet, so it adopts nothing", () => {
        expect(wizardAdoptsDefault(undefined, false, "outrider")).toBe(false);
    });
});

describe("what the last wizard screen says about the default", () => {
    const providers = [
        { id: "openrouter", label: "OpenRouter" },
        { id: "outrider", label: "Outrider" },
    ] as unknown as OnboardingInput["providers"];

    function done(adopts: boolean): readonly string[] {
        const screen = wizardScreen(
            {
                providers,
                pool: { models: {} },
                config: { provider: "openrouter" },
            } as OnboardingInput,
            {
                ...newWizardSession("model"),
                chosen: "outrider",
                connected: "qwen35-2b",
                ...(adopts ? { adopts: true } : {}),
            },
            { os: "darwin", arch: "arm64", memoryGb: 64 },
        );
        return screen.body.kind === "done" ? screen.body.lines : [];
    }

    test("a first provider takes the default and says so", () => {
        expect(done(true)[0]).toBe("Connected. qwen35-2b is your default now.");
    });

    test("a second provider connects without moving the default", () => {
        expect(done(false)[0]).toBe(
            "Connected. qwen35-2b is ready, and OpenRouter is still your default.",
        );
    });
});
