import { expect, test } from "bun:test";

import type { PoolFile } from "../../src/model/pool-file.ts";
import type { OnboardingInput } from "../../src/providers/onboarding.ts";
import type { MachineFacts } from "../../src/providers/recommendation.ts";
import { configuredProviders } from "../../src/providers/registry.ts";
import {
    onboardingCardLines,
    type OnboardingLine,
} from "../../clients/tui/onboarding-screen.ts";
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

function screenText(
    session: WizardSession,
    machine: MachineFacts = MAC,
): string {
    return onboardingCardLines(wizardScreen(COLD, session, machine))
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

test("the first step names a few providers and says how many it left out", () => {
    const groups = providerGroups(PROVIDERS, MAC);
    const listed = groups.flatMap((group) => group.rows.map((row) => row.id));
    expect(listed).toEqual([...new Set(listed)]);
    expect(groups[1]?.rows.map((row) => row.id)).toEqual([
        "openai-codex",
        "ollama",
    ]);
    expect(groups[1]?.more).toBe("300+ more");
    expect(listed).not.toContain("deepseek");
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
    expect(text).toContain("sk-or-v1-abc");
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

test("an empty model list waits for the provider, then says what to do", () => {
    const asking = screenText({
        ...newWizardSession("model"),
        chosen: "ollama",
        asking: true,
    });
    expect(asking).toContain("Asking Ollama for its models");
    expect(asking).not.toContain("ollama run");
    const answered = screenText({
        ...newWizardSession("model"),
        chosen: "ollama",
    });
    expect(answered).toContain("ollama.com/download");
    expect(answered).toContain("ollama run qwen3:8b");
});

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

test("a runtime provider asks to install rather than for a key", () => {
    const text = screenText({
        ...newWizardSession("key"),
        chosen: "outrider",
        runtime: { state: "absent", progress: [] },
    });
    expect(text).toContain("2 ▸ Install");
    expect(text).toContain("Outrider is not on this Mac.");
    expect(text).toContain("Install it");
    expect(text).toContain("I will do it myself");
    expect(text).toContain("github.com/corvines/outrider");
    expect(text).not.toContain("Paste your");
});

test("a download says its size, its share, and what is left to wait", () => {
    const text = screenText({
        ...newWizardSession("model"),
        chosen: "outrider",
        runtime: {
            state: "starting",
            elapsedSeconds: 30,
            progress: [
                { name: "llama.cpp b10516", done: true },
                {
                    name: "qwen35b-mtp",
                    done: false,
                    downloaded: 8_400_000_000,
                    total: 21_000_000_000,
                    etaSeconds: 840,
                },
            ],
        },
    });
    expect(text).toContain("qwen35b-mtp");
    expect(text).toContain("8.4 GB / 21.0 GB");
    expect(text).toContain("40%");
    expect(text).toContain("~14 min");
    expect(text).toContain("█");
    expect(text).toContain("llama.cpp b10516");
});

test("the install gate cannot push the frame open either", () => {
    const sessions: WizardSession[] = [
        {
            ...newWizardSession("key"),
            chosen: "outrider",
            runtime: { state: "absent", progress: [] },
        },
        {
            ...newWizardSession("key"),
            chosen: "outrider",
            runtime: {
                state: "installing",
                progress: [{ name: "z".repeat(300), done: false, downloaded: 1, total: 2 }],
            },
        },
    ];
    for (const session of sessions) {
        for (const line of onboardingCardLines(wizardScreen(COLD, session, MAC))) {
            expect([...line.text].length).toBe(72);
        }
    }
});

test("the install step stays settled while the profile comes up", () => {
    const text = screenText({
        ...newWizardSession("model"),
        chosen: "outrider",
        selected: "qwen35b-mtp",
        runtime: {
            state: "starting",
            progress: [{
                name: "qwen35b-mtp",
                downloaded: 1,
                total: 2,
                done: false,
            }],
        },
    });
    expect(text).toContain("✓   Install");
    expect(text).toContain("installed");
});

function lines(session: WizardSession): readonly OnboardingLine[] {
    return onboardingCardLines(wizardScreen(COLD, session, MAC));
}

/** The runs a line names, concatenated, must still spell the line inside its frame. */
function spansSpellTheLine(line: OnboardingLine): boolean {
    if (line.spans === undefined) return true;
    const inside = [...line.text].slice(1, -1).join("");
    return inside.startsWith(line.spans.map((span) => span.text).join(""));
}

test("a cleared gate is lit, and the gates around it are not", () => {
    const spine = lines({
        ...newWizardSession("model"),
        chosen: "openrouter",
        key: "sk-or-v1-abc",
    }).find((line) => line.tone === "spine");
    expect(spine).toBeDefined();
    const runs = spine!.spans ?? [];
    const lit = runs.filter((span) => span.tone === "cleared")
        .map((span) => span.text.trim());
    expect(lit).toEqual(["✓   Provider", "✓   Key"]);
    // The step being walked is not a gate anyone has cleared.
    expect(runs.some((span) =>
        span.tone === "cleared" && span.text.includes("Model")
    )).toBe(false);
    expect(spansSpellTheLine(spine!)).toBe(true);
});

test("a gate that never applied is not lit, because nobody cleared it", () => {
    const spine = lines({
        ...newWizardSession("model"),
        chosen: "ollama",
        models: [{ id: "qwen3:8b", label: "qwen3:8b" }],
    }).find((line) => line.tone === "spine");
    const lit = (spine?.spans ?? []).filter((span) => span.tone === "cleared")
        .map((span) => span.text.trim());
    expect(lit).toEqual(["✓   Provider"]);
});

test("the key that moves forward is lit, and the one that goes back is not", () => {
    const footer = lines(newWizardSession("provider"))
        .find((line) => line.tone === "footer");
    expect(footer).toBeDefined();
    const invited = (footer!.spans ?? [])
        .filter((span) => span.tone === "invite").map((span) => span.text);
    expect(invited).toEqual(["enter next"]);
    expect(footer!.text).toContain("esc leave setup");
    expect(spansSpellTheLine(footer!)).toBe(true);
});

test("colour adds nothing to the words, so the plain card is unchanged", () => {
    // Every state still reads without colour: the tick and the key names are
    // the markers, and the runs only say which of them to light.
    for (const session of [
        newWizardSession("provider"),
        { ...newWizardSession("key"), chosen: "openrouter" },
        { ...newWizardSession("model"), chosen: "openrouter", key: "sk-or-v1" },
    ]) {
        for (const line of lines(session)) {
            expect(spansSpellTheLine(line)).toBe(true);
        }
    }
});

function modelStep(models: WizardSession["models"]): WizardSession {
    return {
        ...newWizardSession("model"),
        chosen: "openrouter",
        models,
    };
}

/** The rows offered above every other model, which is where the suggestion lives. */
function suggested(models: WizardSession["models"]): readonly string[] {
    const body = wizardScreen(COLD, modelStep(models), MAC).body;
    if (body.kind !== "choice") return [];
    const group = body.groups.find((entry) => entry.label === "GOOD VALUE");
    return group?.rows.map((row) => row.id) ?? [];
}

function modelNotes(models: WizardSession["models"]): readonly string[] {
    const body = wizardScreen(COLD, modelStep(models), MAC).body;
    return body.kind === "choice" ? body.notes ?? [] : [];
}

/** Every row on offer, in the order the user meets them. */
function offered(models: WizardSession["models"]): readonly string[] {
    const body = wizardScreen(COLD, modelStep(models), MAC).body;
    if (body.kind !== "choice") return [];
    return body.groups.flatMap((group) => group.rows.map((row) => row.id));
}

const SMALL_LIST = [
    { id: "openai/gpt-9", label: "GPT-9", outputPrice: 60, waScore: 1700 },
    { id: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash", onPareto: true, outputPrice: 0.25, waScore: 1604 },
    { id: "deepseek/deepseek-v4-flash", label: "V4 Flash", onPareto: true, outputPrice: 0.16, waScore: 1581 },
];

test("the cheap models that score well are offered as rows, cheapest first", () => {
    expect(suggested(SMALL_LIST)).toEqual([
        "deepseek/deepseek-v4-flash",
        "z-ai/glm-5.3-flash",
    ]);
    expect(modelNotes(SMALL_LIST)).toEqual([
        "The models at the top are cheap and score close to the dear ones.",
    ]);
});

test("the suggestion is the first row, so enter on an untouched list picks it", () => {
    // A note above the rows loses to whatever the list opened on. The row has
    // to be the thing the cursor is already sitting on.
    expect(offered(SMALL_LIST)[0]).toBe("deepseek/deepseek-v4-flash");
});

test("a suggested model is offered once, not in two places at once", () => {
    const rows = offered(SMALL_LIST);
    expect(rows).toEqual([...new Set(rows)]);
    expect(rows).toContain("openai/gpt-9");
});

/** The real OpenRouter front on 2026-09-03, cheapest first. */
const LIVE_FRONT = [
    { id: "ibm-granite/granite-4.1-8b", label: "Granite", onPareto: true, outputPrice: 0.1, waScore: 1192 },
    { id: "upstage/solar-pro4", label: "Solar", onPareto: true, outputPrice: 0.12, waScore: 1370 },
    { id: "deepseek/deepseek-v4-flash", label: "V4 Flash", onPareto: true, outputPrice: 0.16, waScore: 1581 },
    { id: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash", onPareto: true, outputPrice: 0.25, waScore: 1604 },
    { id: "tencent/hy4-preview", label: "Hy4", onPareto: true, outputPrice: 2.501, waScore: 1629 },
    { id: "anthropic/claude-opus-5", label: "Opus 5", onPareto: true, outputPrice: 25, waScore: 1688 },
];

test("the weakest models on the front are not named just for being cheapest", () => {
    // Granite and Solar are the cheapest things on the front and score 200 to
    // 400 points under the rest of it. Naming one sends the user off with a
    // model that cannot do the work.
    expect(suggested(LIVE_FRONT)).toEqual([
        "deepseek/deepseek-v4-flash",
        "z-ai/glm-5.3-flash",
        "tencent/hy4-preview",
    ]);
});

test("a model past the price ceiling is not suggested, however well it scores", () => {
    expect(suggested(LIVE_FRONT)).not.toContain("anthropic/claude-opus-5");
    // It is still on offer, just not held up as the cheap answer.
    expect(offered(LIVE_FRONT)).toContain("anthropic/claude-opus-5");
});

test("nothing is suggested when the front holds nothing both cheap and capable", () => {
    const list = [
        { id: "weak/cheap", label: "Weak", onPareto: true, outputPrice: 0.2, waScore: 1200 },
        { id: "strong/dear", label: "Strong", onPareto: true, outputPrice: 25, waScore: 1700 },
    ];
    expect(suggested(list)).toEqual([]);
    expect(modelNotes(list)).toEqual([]);
    expect(offered(list)).toEqual(["weak/cheap", "strong/dear"]);
});

test("the model step suggests at most three, so a suggestion does not become a list", () => {
    const many = ["a", "b", "c", "d", "e"].map((id, at) => ({
        id: `open/${id}`,
        label: id,
        onPareto: true,
        outputPrice: 0.1 * (at + 1),
        waScore: 1600,
    }));
    expect(suggested(many)).toEqual(["open/a", "open/b", "open/c"]);
    // The two it did not suggest are still on offer below.
    expect(offered(many)).toContain("open/d");
});

test("with no scores to go on, the model step suggests nothing rather than guessing", () => {
    const unscored = [
        { id: "openai/gpt-9", label: "GPT-9" },
        { id: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash" },
    ];
    expect(suggested(unscored)).toEqual([]);
    expect(modelNotes(unscored)).toEqual([]);
});

test("the suggestion is painted under its own heading, above everything else", () => {
    const text = screenText(modelStep([
        { id: "openai/gpt-9", label: "GPT-9", outputPrice: 60, waScore: 1700 },
        { id: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash", onPareto: true, outputPrice: 0.25, waScore: 1604 },
    ]));
    expect(text).toContain("GOOD VALUE");
    expect(text.indexOf("GOOD VALUE")).toBeLessThan(text.indexOf("OTHER"));
    expect(text.indexOf("GLM 5.3 Flash")).toBeLessThan(text.indexOf("GPT-9"));
});

test("the install screen sizes the machine against the work model", () => {
    const absent: WizardSession = {
        ...newWizardSession("key"),
        chosen: "outrider",
        runtime: { state: "absent", progress: [] },
    };
    expect(screenText(absent)).toContain("You have 64 GB, which is plenty.");
    expect(screenText(absent, { ...MAC, memoryGb: 16 }))
        .toContain("You have 16 GB, which is enough for the lite model.");
});

test("the line the install screen draws is the work model's own number", () => {
    // A provider asking for 48 puts a 40 GB machine on the lite side, where
    // any number written into the screen itself would have put it on the other.
    const outrider = PROVIDERS.find((entry) => entry.id === "outrider")!;
    const hungry = {
        ...outrider,
        recommendModels: outrider.recommendModels?.map((entry) =>
            entry.role === "work"
                ? { ...entry, requires: { memory_gb: 48 } }
                : entry
        ),
    };
    const session: WizardSession = {
        ...newWizardSession("key"),
        chosen: "outrider",
        runtime: { state: "absent", progress: [] },
    };
    const text = onboardingCardLines(wizardScreen(
        { ...COLD, providers: [hungry] },
        session,
        { ...MAC, memoryGb: 40 },
    )).map((line) => line.text).join("\n");
    expect(text).toContain("You have 40 GB, which is enough for the lite model.");
});
