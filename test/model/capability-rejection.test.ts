import { expect, test } from "bun:test";

import { classifyCapabilityRejection } from "../../src/model/capability-rejection.ts";
import { IMAGES_LEARNED_KEY } from "../../src/model/pool-file.ts";
import type { ProviderFailure } from "../../src/model/provider-failure.ts";

function failure(patch: Partial<ProviderFailure>): ProviderFailure {
    return {
        kind: "invalid_request",
        resolution: "user_action",
        message: "",
        ...patch,
    };
}

test("an OpenAI unsupported-value body is an effort rejection", () => {
    const rejection = classifyCapabilityRejection(failure({
        statusCode: 400,
        message: 'OpenAI Codex returned 400: {"error":{"message":"Invalid value: '
            + "'xhigh'. Supported values are: 'low', 'medium', and 'high'.\","
            + '"type":"invalid_request_error","param":"reasoning.effort",'
            + '"code":"invalid_value"}}',
    }));
    expect(rejection?.parameter).toBe("reasoning_effort");
});

test("an OpenAI unsupported-parameter body is an effort rejection", () => {
    const rejection = classifyCapabilityRejection(failure({
        statusCode: 400,
        message: "OpenAI Codex returned 400: "
            + '{"error":{"message":"Unsupported parameter: \'reasoning.effort\' '
            + 'is not supported with this model.","code":"unsupported_parameter"}}',
    }));
    expect(rejection?.parameter).toBe("reasoning_effort");
});

test("a Cerebras 400 naming reasoning_effort is an effort rejection", () => {
    const rejection = classifyCapabilityRejection(failure({
        statusCode: 400,
        message: "Cerebras returned HTTP 400: "
            + '{"message":"reasoning_effort is not supported for model zai-glm-4.7",'
            + '"type":"invalid_request_error","param":"reasoning_effort"}',
    }));
    expect(rejection?.parameter).toBe("reasoning_effort");
    expect(rejection?.message).toContain("reasoning_effort is not supported");
});

test("an OpenRouter upstream refusal is read from the parsed provider message", () => {
    const rejection = classifyCapabilityRejection(failure({
        statusCode: 400,
        message: "Provider returned error",
        providerErrorType: "invalid_request",
        providerMessage: "xhigh is not a valid reasoning effort for this model",
    }));
    expect(rejection).toEqual({
        parameter: "reasoning_effort",
        message: "xhigh is not a valid reasoning effort for this model",
    });
});

test("an Ollama thinking refusal is a thinking rejection", () => {
    const rejection = classifyCapabilityRejection(failure({
        statusCode: 400,
        message: "Ollama returned HTTP 400: "
            + '{"error":"registry.ollama.ai/library/llama3:latest does not '
            + 'support thinking"}',
    }));
    expect(rejection?.parameter).toBe("thinking");
});

test("an OpenRouter tool-routing 404 is a tools rejection", () => {
    const rejection = classifyCapabilityRejection(failure({
        kind: "not_found",
        statusCode: 404,
        message: "No endpoints found that support tool use",
    }));
    expect(rejection?.parameter).toBe("tools");
});

test("a plain missing-model 404 is not a rejection", () => {
    expect(classifyCapabilityRejection(failure({
        kind: "not_found",
        statusCode: 404,
        message: "No endpoints found for kimi-k3",
    }))).toBeUndefined();
});

test("a rate limit is never a capability rejection", () => {
    expect(classifyCapabilityRejection(failure({
        kind: "rate_limit",
        resolution: "retry",
        statusCode: 429,
        message: "Rate limit exceeded: reasoning effort requests are throttled",
    }))).toBeUndefined();
});

test("a transport failure is never a capability rejection", () => {
    expect(classifyCapabilityRejection(failure({
        kind: "connection",
        resolution: "retry",
        message: "fetch failed",
    }))).toBeUndefined();
});

test("a server overload is never a capability rejection", () => {
    expect(classifyCapabilityRejection(failure({
        kind: "server",
        resolution: "retry",
        statusCode: 503,
        message: "upstream provider does not support requests right now",
    }))).toBeUndefined();
});

test("a context-length 400 is not a capability rejection", () => {
    expect(classifyCapabilityRejection(failure({
        kind: "request_too_large",
        statusCode: 400,
        message: "This model's maximum context length is 200000 tokens",
    }))).toBeUndefined();
});

test("a 400 that refuses nothing recognisable is not a rejection", () => {
    expect(classifyCapabilityRejection(failure({
        statusCode: 400,
        message: "messages: array too short",
    }))).toBeUndefined();
});

test("an image-input refusal is an images rejection", () => {
    const rejection = classifyCapabilityRejection(failure({
        statusCode: 400,
        message: "glm-5.2 does not support image input",
    }));
    expect(rejection?.parameter).toBe("images");
});

test("an image-naming 404 stays a missing model, not an images rejection", () => {
    expect(classifyCapabilityRejection(failure({
        kind: "not_found",
        statusCode: 404,
        message: "No endpoints found that support image input",
    }))).toBeUndefined();
});

test("an image refusal records under the images learned key", () => {
    const rejection = classifyCapabilityRejection(failure({
        statusCode: 400,
        message: "Invalid value for image_url: this model is text only",
    }));
    expect(rejection?.parameter).toBe(IMAGES_LEARNED_KEY);
});
