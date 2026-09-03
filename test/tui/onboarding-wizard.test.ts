import { expect, test } from "bun:test";

import type { PoolFile } from "../../src/model/pool-file.ts";
import type { OnboardingInput } from "../../src/providers/onboarding.ts";
import type { MachineFacts } from "../../src/providers/recommendation.ts";
import { configuredProviders } from "../../src/providers/registry.ts";
import { onboardingCardLines } from "../../clients/tui/onboarding-screen.ts";
import {
    newWizardSession,
    providerGroups,
    wizardScreen,
    type WizardSession,
} from "../../clients/tui/onboarding-wizard.ts";

const PROVIDERS = configuredProviders(undefined);

const EMPTY_POOL: PoolFile = { defaults: {}, models: {} };

const MAC: MachineFacts = { os: "darwin", arch: "arm64", memoryGb: 64 };

const COLD: OnboardingInput = {
    providers: PROVIDERS,
    pool: EMPTY_POOL,
    authStorage: { getCredential: () => undefined },
    env: {},
};

function screenText(session: WizardSession): string {
    return onboardingCardLines(wizardScreen(COLD, session, MAC))
        .map((line) => line.text)
        .join("\n");
}

test("the first step recommends before it lists", () => {
    const groups = providerGroups(PROVIDERS, MAC);
    expect(groups[0]?.label).toBe("RECOMMENDED");
    expect(groups[0]?.rows[0]?.id).toBe("openrouter");
    expect(groups[1]?.label).toBe("OTHER");
    expect(groups[1]?.rows.some((row) => row.id === "openrouter")).toBe(false);
});

test("every configured provider is on the first step exactly once", () => {
    const listed = providerGroups(PROVIDERS, MAC)
        .flatMap((group) => group.rows.map((row) => row.id));
    expect([...listed].sort()).toEqual(
        PROVIDERS.map((provider) => provider.id).sort(),
    );
});

test("step one asks who runs the models and offers no way back but out", () => {
    const text = screenText(newWizardSession("provider"));
    expect(text).toContain("1 ▸ Provider");
    expect(text).toContain("Who runs your models?");
    expect(text).toContain("esc leave setup");
});

test("the key step names the provider and says where the key goes", () => {
    const text = screenText({
        ...newWizardSession("key"),
        chosen: "openrouter",
        key: "sk-or-v1-abc",
    });
    expect(text).toContain("✓   Provider");
    expect(text).toContain("2 ▸ Key");
    expect(text).toContain("Paste your OpenRouter key.");
    expect(text).toContain("Kept in your keychain. Only ever sent to OpenRouter.");
    expect(text).toContain("Or set OPENROUTER_API_KEY in your shell.");
    expect(text).toContain("•".repeat("sk-or-v1-abc".length));
    expect(text).toContain("esc back");
});

test("a refusal shows the provider's own words on the key step", () => {
    const text = screenText({
        ...newWizardSession("key"),
        chosen: "openrouter",
        alert: "OpenRouter refused that key: no auth credentials found",
    });
    expect(text).toContain("! OpenRouter refused that key");
});

test("a keyless provider draws its second gate as settled, never hidden", () => {
    const text = screenText({
        ...newWizardSession("model"),
        chosen: "ollama",
        models: [{ id: "qwen3:8b", label: "qwen3:8b" }],
    });
    expect(text).toContain("–   Setup");
    expect(text).toContain("not needed");
    expect(text).toContain("3 ▸ Model");
});

const OUTRIDER_MODELS = [
    { id: "tiny", label: "tiny" },
    { id: "granite4.2-3b", label: "granite4.2-3b" },
    { id: "qwen35b-mtp", label: "qwen35b-mtp" },
];

test("the model step offers jobs before model names", () => {
    const screen = wizardScreen(COLD, {
        ...newWizardSession("model"),
        chosen: "outrider",
        models: OUTRIDER_MODELS,
    }, MAC);
    const groups = screen.body.kind === "choice" ? screen.body.groups : [];
    expect(groups[0]?.label).toBe("RECOMMENDED");
    expect(groups[0]?.rows.map((row) => row.id))
        .toEqual(["qwen35b-mtp", "granite4.2-3b"]);
    expect(groups[0]?.rows[0]?.label).toBe("A model that does the work");
    expect(groups[1]?.label).toBe("OTHER");
    expect(groups[1]?.rows.map((row) => row.id)).toEqual(["tiny"]);
});

test("a small Mac is still recommended Outrider, with the lite job first", () => {
    const small = providerGroups(PROVIDERS, {
        os: "darwin",
        arch: "arm64",
        memoryGb: 16,
    });
    expect(small[0]?.rows.map((row) => row.id)).toContain("outrider");
    const screen = wizardScreen(COLD, {
        ...newWizardSession("model"),
        chosen: "outrider",
        models: OUTRIDER_MODELS,
    }, { os: "darwin", arch: "arm64", memoryGb: 16 });
    const groups = screen.body.kind === "choice" ? screen.body.groups : [];
    expect(groups[0]?.label).toBe("RECOMMENDED");
    expect(groups[0]?.rows.map((row) => row.id)).toEqual(["granite4.2-3b"]);
    expect(groups[1]?.label).toBe("WILL NOT FIT ON THIS MAC");
    expect(groups[1]?.rows.map((row) => row.id)).toEqual(["qwen35b-mtp"]);
    expect(groups[1]?.rows[0]?.note)
        .toBe("needs 32 GB, this Mac has 16 GB");
});

test("a recommendation for a model the provider does not list is not offered", () => {
    const screen = wizardScreen(COLD, {
        ...newWizardSession("model"),
        chosen: "outrider",
        models: [{ id: "tiny", label: "tiny" }],
    }, MAC);
    const groups = screen.body.kind === "choice" ? screen.body.groups : [];
    expect(groups).toHaveLength(1);
    expect(groups[0]?.rows.map((row) => row.id)).toEqual(["tiny"]);
});

test("a row that spills onto a second line is not crowded by the next one", () => {
    const lines = onboardingCardLines(wizardScreen(COLD, {
        ...newWizardSession("model"),
        chosen: "outrider",
        models: OUTRIDER_MODELS,
    }, MAC)).map((line) => line.text.slice(1, -1).trimEnd());
    const note = lines.findIndex((line) =>
        line.includes("tools, thinking, 32K context")
    );
    expect(note).toBeGreaterThan(0);
    expect(lines[note + 1]).toBe("");
    expect(lines[note + 2]).toContain("Lite model to get started");
});

test("the model step searches only once a list is too long to scan", () => {
    const short = wizardScreen(COLD, {
        ...newWizardSession("model"),
        chosen: "openrouter",
        models: [{ id: "a", label: "a" }],
    }, MAC);
    expect(short.body.kind === "choice" && short.body.query).toBeUndefined();
    const long = wizardScreen(COLD, {
        ...newWizardSession("model"),
        chosen: "openrouter",
        models: Array.from({ length: 40 }, (_, index) => ({
            id: `m${index}`,
            label: `m${index}`,
        })),
    }, MAC);
    expect(long.body.kind === "choice" && long.body.query).toBe("");
});

test("verifying watches the model answer rather than spinning alone", () => {
    const text = screenText({
        ...newWizardSession("model"),
        chosen: "openrouter",
        verifying: {
            model: "openai/gpt-5.6",
            elapsedSeconds: 9,
            reachable: true,
            answered: false,
        },
    });
    expect(text).toContain("Asking openai/gpt-5.6 to say hello");
    expect(text).toContain("9s");
    expect(text).toContain("✓ reachable");
    expect(text).toContain("esc pick a different model");
});

test("the last screen says a lite model is a way in, and names the way on", () => {
    const said = (connected: string): string => {
        const body = wizardScreen(COLD, {
            ...newWizardSession("model"),
            chosen: "outrider",
            connected,
        }, MAC).body;
        return body.kind === "done" ? body.lines.join(" ") : "";
    };
    expect(said("granite4.2-3b")).toContain("It is small.");
    expect(said("granite4.2-3b")).toContain('how do I add OpenRouter"');
    expect(said("qwen35b-mtp")).not.toContain("It is small.");
    const drawn = onboardingCardLines(wizardScreen(COLD, {
        ...newWizardSession("model"),
        chosen: "outrider",
        connected: "granite4.2-3b",
    }, MAC));
    expect(drawn.some((line) => line.text.includes("way around. When"))).toBe(
        true,
    );
});

test("the last screen says what the default is now", () => {
    const text = screenText({
        ...newWizardSession("model"),
        chosen: "openrouter",
        connected: "openai/gpt-5.6",
        key: "k",
    });
    expect(text).toContain("✓   Model");
    expect(text).toContain("Connected. openai/gpt-5.6 is your default now.");
    expect(text).toContain("enter start working");
});

test("no step of the wizard can push the frame open", () => {
    const sessions: WizardSession[] = [
        newWizardSession("provider"),
        { ...newWizardSession("key"), chosen: "openrouter", key: "x".repeat(300) },
        {
            ...newWizardSession("model"),
            chosen: "openrouter",
            models: [{ id: "y".repeat(300), label: "z".repeat(300) }],
        },
        {
            ...newWizardSession("model"),
            chosen: "openrouter",
            connected: "w".repeat(300),
        },
    ];
    for (const session of sessions) {
        for (const line of onboardingCardLines(wizardScreen(COLD, session, MAC))) {
            expect([...line.text].length).toBe(72);
        }
    }
});
