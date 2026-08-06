import { expect, test } from "bun:test";

import {
    resolveSubagentModel,
    type LadderCandidate,
    type LadderPool,
    type SubagentModelRequest,
} from "../../src/model/subagent-ladder.ts";

function candidate(
    ref: string,
    overrides: Partial<LadderCandidate> = {},
): LadderCandidate {
    const [provider, model] = ref.split("/");
    return {
        provider: provider ?? "",
        model: model ?? "",
        available: true,
        levels: ["high", "medium", "low"],
        tools: true,
        ...overrides,
    };
}

const session = {
    sessionProvider: "openrouter",
    sessionModel: "session-model",
    sessionEffort: "high",
} satisfies Partial<SubagentModelRequest>;

function ask(
    request: Partial<SubagentModelRequest>,
    pool: Partial<LadderPool>,
): ReturnType<typeof resolveSubagentModel> {
    return resolveSubagentModel(
        { ...session, ...request },
        { models: [candidate("openrouter/session-model")], ...pool },
    );
}

test("a runnable suggestion is taken as asked, with nothing substituted", () => {
    const outcome = ask({ suggested: "openrouter/fast", suggestedEffort: "low" }, {
        models: [candidate("openrouter/session-model"), candidate("openrouter/fast")],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rung).toBe("suggestion");
    expect(outcome.model).toBe("fast");
    expect(outcome.effort).toBe("low");
    expect(outcome.substitutions).toEqual([]);
    expect(outcome.notice).toBeUndefined();
});

test("an unsupported effort degrades in place rather than failing the model", () => {
    const outcome = ask({ suggested: "openrouter/fast", suggestedEffort: "xhigh" }, {
        models: [
            candidate("openrouter/session-model"),
            candidate("openrouter/fast", { levels: ["high", "low"] }),
        ],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rung).toBe("suggestion");
    expect(outcome.effort).toBe("high");
    expect(outcome.notice).toContain("does not offer that level");
});

test("a failed suggestion falls to a sibling in the same provider and family", () => {
    const outcome = ask({ suggested: "openrouter/big" }, {
        models: [
            candidate("openrouter/session-model"),
            candidate("openrouter/big", { family: "kimi", available: false }),
            candidate("openrouter/small", { family: "kimi" }),
        ],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rung).toBe("sibling");
    expect(outcome.model).toBe("small");
    expect(outcome.notice).toContain(
        "Requested model openrouter/big, ran openrouter/small instead",
    );
});

test("a model of another family is never used as a sibling", () => {
    const outcome = ask({ suggested: "openrouter/big" }, {
        models: [
            candidate("openrouter/session-model"),
            candidate("openrouter/big", { family: "kimi", available: false }),
            candidate("openrouter/other", { family: "qwen" }),
        ],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rung).toBe("self");
});

test("the configured default takes over when the suggestion cannot run", () => {
    const outcome = ask(
        { suggested: "openrouter/missing", configuredDefault: "openrouter/cheap" },
        {
            models: [
                candidate("openrouter/session-model"),
                candidate("openrouter/cheap"),
            ],
        },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rung).toBe("default");
    expect(outcome.model).toBe("cheap");
});

test("self runs at the configured relative effort, not the session's", () => {
    const lowest = ask({ selfEffort: "lowest" }, {});
    expect(lowest.ok).toBe(true);
    if (!lowest.ok) return;
    expect(lowest.rung).toBe("self");
    expect(lowest.effort).toBe("low");

    const equal = ask({ selfEffort: "equal" }, {});
    expect(equal.ok && equal.effort).toBe("high");

    const explicit = ask({ selfEffort: "medium" }, {});
    expect(explicit.ok && explicit.effort).toBe("medium");
});

test("an explicit self effort the model lacks is raised to its nearest level", () => {
    const outcome = ask({ selfEffort: "off" }, {
        models: [
            candidate("openrouter/session-model", { levels: ["high", "medium"] }),
        ],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.effort).toBe("medium");
});

test("the pool failsafe is the only rung that crosses a provider", () => {
    const outcome = ask({}, {
        models: [
            candidate("openrouter/session-model", { available: false }),
            candidate("cerebras/other-provider"),
            candidate("ollama/failsafe-one", { family: "llama" }),
        ],
        failsafe: ["ollama/failsafe-one"],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rung).toBe("pool");
    expect(outcome.provider).toBe("ollama");
    expect(outcome.notice).toContain("a verified model from the user's pool");
});

test("a pool model that cannot call tools is not used as the failsafe", () => {
    const outcome = ask({}, {
        models: [
            candidate("openrouter/session-model", { available: false }),
            candidate("ollama/prose-only", { tools: false }),
            candidate("ollama/failsafe-two"),
        ],
        failsafe: ["ollama/prose-only", "ollama/failsafe-two"],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.model).toBe("failsafe-two");
});

test("unknown tool support does not pass the failsafe gate", () => {
    const outcome = ask({}, {
        models: [
            candidate("openrouter/session-model", { available: false }),
            candidate("ollama/unknown", { tools: undefined }),
        ],
        failsafe: ["ollama/unknown"],
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("not known to support tool calling");
});

test("the tool-call gate applies to the failsafe only, not to earlier rungs", () => {
    const outcome = ask({ suggested: "openrouter/prose-only" }, {
        models: [
            candidate("openrouter/session-model"),
            candidate("openrouter/prose-only", { tools: false }),
        ],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rung).toBe("suggestion");
});

test("an unpooled model on another provider is never reached automatically", () => {
    const outcome = ask({ suggested: "openrouter/gone" }, {
        models: [
            candidate("openrouter/session-model", { available: false }),
            candidate("cerebras/perfectly-fine"),
        ],
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("No model could run this subagent");
});

test("deny gates every rung, including self and the pool failsafe", () => {
    const pool: Partial<LadderPool> = {
        models: [
            candidate("openrouter/session-model", { family: "kimi" }),
            candidate("openrouter/big", { family: "kimi" }),
            candidate("openrouter/small", { family: "kimi" }),
            candidate("ollama/failsafe-one"),
        ],
        failsafe: ["ollama/failsafe-one"],
    };
    const rungs: readonly [string, Partial<SubagentModelRequest>][] = [
        ["openrouter/big", { suggested: "openrouter/big" }],
        ["openrouter/small", { suggested: "openrouter/big" }],
        ["openrouter/session-model", { configuredDefault: "openrouter/session-model" }],
        ["ollama/failsafe-one", {}],
    ];
    for (const [denied, request] of rungs) {
        const outcome = resolveSubagentModel(
            { ...session, ...request },
            { ...pool, models: pool.models ?? [], deny: [denied] },
        );
        if (outcome.ok) {
            expect(`${outcome.provider}/${outcome.model}`).not.toBe(denied);
        } else {
            expect(outcome.error).toContain(`${denied} is denied`);
        }
    }
});

test("deny wins over an explicit allow of the same model", () => {
    const outcome = ask({ suggested: "openrouter/free-tier" }, {
        models: [
            candidate("openrouter/session-model"),
            candidate("openrouter/free-tier"),
        ],
        allow: ["*"],
        deny: ["openrouter/*-tier"],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.model).toBe("session-model");
});

test("a model outside the allow list is not reachable on any rung", () => {
    const outcome = ask({ suggested: "openrouter/elsewhere" }, {
        models: [
            candidate("openrouter/session-model"),
            candidate("openrouter/elsewhere"),
        ],
        allow: ["openrouter/session-*"],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.model).toBe("session-model");
});

test("nothing runnable anywhere fails loudly and lists the rejections", () => {
    const outcome = ask({ suggested: "openrouter/gone" }, {
        models: [candidate("openrouter/session-model", { available: false })],
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("openrouter/gone is not in the pool");
    expect(outcome.error).toContain("openrouter/session-model is not available");
});

test("every substitution says what was requested, what ran, and why", () => {
    const outcome = ask({ suggested: "openrouter/big", suggestedEffort: "max" }, {
        models: [
            candidate("openrouter/session-model"),
            candidate("openrouter/big", { family: "kimi", available: false }),
            candidate("openrouter/small", { family: "kimi", levels: ["medium"] }),
        ],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.substitutions).toHaveLength(2);
    expect(outcome.substitutions[0]?.scope).toBe("model");
    expect(outcome.substitutions[0]?.requested).toBe("openrouter/big");
    expect(outcome.substitutions[0]?.using).toBe("openrouter/small");
    // The rejection itself, not a restatement that something was rejected.
    expect(outcome.substitutions[0]?.reason).toContain(
        "openrouter/big is not available right now",
    );
    expect(outcome.substitutions[1]?.scope).toBe("effort");
    expect(outcome.substitutions[1]?.requested).toBe("max");
    expect(outcome.substitutions[1]?.using).toBe("medium");
    expect(outcome.notice).toContain("because");
});
