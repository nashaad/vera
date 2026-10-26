import { expect, test } from "bun:test";

import { classifierFailureText, modelFailureText } from "../../clients/tui/failure-text.ts";

const afternoon = new Date(2026, 9, 15, 14, 0).getTime();
const resets = new Date(2026, 9, 15, 18, 35).getTime();
const ACCOUNT_FIX = "open /settings, then Classifier, and pick a model on another provider, or set a failsafe there.";
const MODEL_FIX = "open /settings, then Classifier, and pick another model, or set a failsafe there.";

test("a spent usage limit names the classifier and when it resets", () => {
    const failure = {
        tool: "write",
        classifier: "openai-codex/gpt-6-luna",
        kind: "rate_limit" as const,
        resetsAt: resets,
    };

    expect(classifierFailureText(failure, afternoon)).toEqual({
        headline: "write did not run",
        message: "The classifier, openai-codex/gpt-6-luna, is out of usage until 6:35 PM.",
        fix: ACCOUNT_FIX,
    });
    expect(classifierFailureText(failure, new Date(2026, 9, 14, 23, 0).getTime()).message)
        .toBe("The classifier, openai-codex/gpt-6-luna, is out of usage until Oct 15, 6:35 PM.");
    expect(classifierFailureText(failure, new Date(2026, 9, 15, 19, 0).getTime()).message)
        .toBe("The classifier, openai-codex/gpt-6-luna, was out of usage until 6:35 PM.");
});

test("a rate limit with no reset time says to wait or switch provider", () => {
    expect(classifierFailureText({
        tool: "write",
        classifier: "faux/crow-classifier",
        kind: "rate_limit",
    }, afternoon)).toEqual({
        headline: "write did not run",
        message: "The classifier, faux/crow-classifier, hit its provider's rate or usage limit.",
        fix: "wait a minute and send again, or open /settings, then Classifier, and pick a model on another provider.",
    });
});

test("each failure kind says what went wrong and what to change", () => {
    const base = { tool: "bash", classifier: "openrouter/qwen/qwen3.8-max" };

    expect(classifierFailureText({ ...base, kind: "timeout", timeoutMs: 60_000 }, afternoon))
        .toEqual({
            headline: "bash did not run",
            message: "The classifier, openrouter/qwen/qwen3.8-max, did not answer within 60s.",
            fix: MODEL_FIX,
        });
    expect(classifierFailureText({ tool: "bash", kind: "no_route" }, afternoon)).toEqual({
        headline: "bash did not run",
        message: "No classifier model is set.",
        fix: "open /settings, then Classifier, and pick a model.",
    });
    expect(classifierFailureText({ ...base, kind: "payment_required" }, afternoon)).toEqual({
        headline: "bash did not run",
        message: "The classifier, openrouter/qwen/qwen3.8-max, is out of credit.",
        fix: ACCOUNT_FIX,
    });
    expect(classifierFailureText({ ...base, kind: "unreadable" }, afternoon).message)
        .toBe("The classifier, openrouter/qwen/qwen3.8-max, gave an answer Vera could not read.");
    expect(classifierFailureText({ ...base, kind: "undescribed" }, afternoon)).toEqual({
        headline: "bash did not run",
        message: "Vera could not describe the action to the classifier.",
        fix: "ask Vera to try the action again.",
    });
    expect(classifierFailureText({
        ...base,
        kind: "server",
        detail: "OpenRouter returned 502: upstream crow fell off the mast\nstack trace",
    }, afternoon)).toEqual({
        headline: "bash did not run",
        message: "The classifier, openrouter/qwen/qwen3.8-max, failed: OpenRouter returned 502: upstream crow fell off the mast",
        fix: MODEL_FIX,
    });
});

test("a long provider detail is cut to one short line", () => {
    const text = classifierFailureText({
        tool: "bash",
        classifier: "test",
        kind: "unknown",
        detail: "x".repeat(400),
    }, afternoon);

    expect(text.message.length).toBeLessThan(220);
    expect(text.message.endsWith("…")).toBe(true);
});

test("a failed model request names the model, the provider's words and a fix", () => {
    const model = "faux/crow-main";

    expect(modelFailureText({
        model,
        kind: "invalid_request",
        statusCode: 400,
        providerMessage: "The crow dropped the request in a storm.",
    }, afternoon)).toEqual({
        message: "The model, faux/crow-main, rejected the request: The crow dropped the request in a storm.",
        fix: "pick another model with /model. The Vera report in /diagnostics has the full error.",
    });
    expect(modelFailureText({ model, kind: "rate_limit", resetsAt: resets }, afternoon)).toEqual({
        message: "The model, faux/crow-main, is out of usage until 6:35 PM.",
        fix: "wait until then, or pick a model on another provider with /model.",
    });
    expect(modelFailureText({ model, kind: "rate_limit" }, afternoon)).toEqual({
        message: "The model, faux/crow-main, hit its provider's rate or usage limit.",
        fix: "wait a minute and send again, or pick a model on another provider with /model.",
    });
    expect(modelFailureText({ model, kind: "authentication", statusCode: 401 }, afternoon)).toEqual({
        message: "The model, faux/crow-main, rejected Vera's credentials.",
        fix: "check the provider's API key in Configure providers (Ctrl+P), or pick another model with /model.",
    });
    expect(modelFailureText({ model, kind: "request_too_large" }, afternoon).fix)
        .toBe("run /compact, or pick a model with a larger context with /model.");
    expect(modelFailureText({ model, kind: "server", statusCode: 502 }, afternoon)).toEqual({
        message: "The model, faux/crow-main, failed with a server error.",
        fix: "send again. If it keeps failing, pick another model with /model.",
    });
});
