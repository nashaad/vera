/**
 * The admission service: the one place a model earns its way into the pool.
 *
 * Tier 1 is free: whatever the provider's own listing already said, carried in
 * on the catalog model. The probes only answer what metadata cannot: does this
 * model respond on this key, which reasoning levels actually work, and does it
 * call tools. Health and compatibility never mix. A retry-shaped failure
 * (connection, timeout, server, rate limit) ends the admission as unavailable
 * with no verdict recorded; only a provider rejection the user must act on
 * records an incompatibility.
 *
 * This module knows no provider endpoints. Adapters carry the protocol
 * knowledge; the pool store carries the persistence. It consumes only the
 * `ModelAdapter` interface and the failure vocabulary.
 */

import type { CatalogModel } from "./catalog-shape.ts";
import type {
    PoolVerification,
    VerifiedPoolLevel,
} from "./pool-store.ts";
import { ProviderFailureError } from "./provider-failure.ts";
import type {
    AssistantMessage,
    ModelAdapter,
    ModelReasoningEffort,
    ModelRequest,
    ModelStream,
} from "./types.ts";

const PROBE_SENTINEL = "vera-admission-ok";
const PROBE_MAX_TOKENS = 2_048;
const PROBE_TIMEOUT_MS = 60_000;
const PROBE_TOOL_NAME = "admission_probe";

export type AdmissionStepStatus =
    | "running"
    | "passed"
    | "failed"
    | "skipped";

export interface AdmissionStep {
    readonly step: string;
    readonly label: string;
    readonly status: AdmissionStepStatus;
    readonly detail?: string;
}

export interface AdmissionRequest {
    readonly adapter: ModelAdapter;
    readonly provider: string;
    readonly model: string;
    /** Tier-1 metadata from discovery; absent means everything is unknown. */
    readonly catalogModel?: CatalogModel;
    readonly checked?: "user_key" | "vera";
    readonly onStep?: (step: AdmissionStep) => void;
    readonly signal?: AbortSignal;
    readonly now?: () => Date;
}

export type AdmissionVerdict =
    | {
        readonly status: "added";
        readonly verification: PoolVerification;
        /** Levels the catalog offered that this key could not use. */
        readonly droppedLevels: readonly string[];
    }
    | {
        readonly status: "incompatible";
        readonly reason: string;
        readonly statusCode?: number;
    }
    | {
        readonly status: "unavailable";
        readonly reason: string;
    };

class AdmissionUnavailable extends Error {}

export async function admitModel(
    request: AdmissionRequest,
): Promise<AdmissionVerdict> {
    try {
        return await runAdmission(request);
    } catch (error) {
        if (error instanceof AdmissionUnavailable) {
            return { status: "unavailable", reason: error.message };
        }
        throw error;
    }
}

async function runAdmission(
    request: AdmissionRequest,
): Promise<AdmissionVerdict> {
    const candidates = request.catalogModel?.levels ?? [];
    const verified: VerifiedPoolLevel[] = [];
    const dropped: string[] = [];
    let responseModel: string | undefined;

    if (candidates.length === 0) {
        const step = stepReporter(request, "response", "Model responds");
        const outcome = await probeText(request, undefined);
        if (outcome.kind === "incompatible") {
            step("failed", outcome.reason);
            return outcome.verdict;
        }
        responseModel = outcome.responseModel;
        step("passed");
    }

    for (const level of candidates) {
        const step = stepReporter(
            request,
            `level:${level.id}`,
            `Reasoning ${level.label}`,
        );
        const outcome = await probeText(request, level.id);
        if (outcome.kind === "incompatible") {
            step("failed", outcome.reason);
            dropped.push(level.id);
            continue;
        }
        responseModel ??= outcome.responseModel;
        verified.push({
            vera_effort: veraEffortForLevel(level.id),
            provider_effort: level.id,
        });
        step("passed");
    }

    if (candidates.length > 0 && verified.length === 0) {
        // Every advertised level was rejected; the model may still work with
        // no level named at all, entering the pool without reasoning control.
        const step = stepReporter(request, "response", "Model responds");
        const outcome = await probeText(request, undefined);
        if (outcome.kind === "incompatible") {
            step("failed", outcome.reason);
            return outcome.verdict;
        }
        responseModel = outcome.responseModel;
        step("passed");
    }

    const toolStep = stepReporter(request, "tool_call", "Calls a tool");
    const toolOutcome = await probeToolCall(
        request,
        verified[0]?.provider_effort,
    );
    if (toolOutcome !== undefined) {
        toolStep("failed", toolOutcome.reason);
        return toolOutcome.verdict;
    }
    toolStep("passed");

    return {
        status: "added",
        verification: {
            verified_at: (request.now?.() ?? new Date()).toISOString(),
            response_model: responseModel ?? request.model,
            levels: verified,
            checked: request.checked ?? "user_key",
        },
        droppedLevels: dropped,
    };
}

interface IncompatibleOutcome {
    readonly kind: "incompatible";
    readonly reason: string;
    readonly verdict: AdmissionVerdict & { readonly status: "incompatible" };
}

interface PassedOutcome {
    readonly kind: "passed";
    readonly responseModel: string;
}

async function probeText(
    request: AdmissionRequest,
    providerEffort: string | undefined,
): Promise<IncompatibleOutcome | PassedOutcome> {
    const result = await probeOnce(request, {
        maxTokens: PROBE_MAX_TOKENS,
        ...(providerEffort === undefined
            ? {}
            : { reasoningEffort: providerEffort }),
        messages: [{
            role: "user",
            content: [{
                type: "text",
                text: `Reply with exactly: ${PROBE_SENTINEL}`,
            }],
        }],
    });
    if (result.kind === "incompatible") {
        return result;
    }
    const text = result.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
    if (!text.toLowerCase().includes(PROBE_SENTINEL)) {
        return incompatible("returned unexpected text for the probe prompt");
    }
    return {
        kind: "passed",
        responseModel: result.message.source.responseModel
            ?? result.message.source.model,
    };
}

async function probeToolCall(
    request: AdmissionRequest,
    providerEffort: string | undefined,
): Promise<IncompatibleOutcome | undefined> {
    const result = await probeOnce(request, {
        maxTokens: PROBE_MAX_TOKENS,
        ...(providerEffort === undefined
            ? {}
            : { reasoningEffort: providerEffort }),
        messages: [{
            role: "user",
            content: [{
                type: "text",
                text: `Call ${PROBE_TOOL_NAME} with value ok. `
                    + "Do not answer in text.",
            }],
        }],
        tools: [{
            name: PROBE_TOOL_NAME,
            description: "Verify that this model can call a Vera tool.",
            inputSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
            },
        }],
    });
    if (result.kind === "incompatible") {
        return result;
    }
    const toolCall = result.message.content
        .find((block) => block.type === "tool_call");
    if (toolCall?.type !== "tool_call" || toolCall.name !== PROBE_TOOL_NAME) {
        return incompatible("did not call the probe tool");
    }
    return undefined;
}

interface ProbeSuccess {
    readonly kind: "success";
    readonly message: AssistantMessage;
}

/**
 * One probe call, with one retry for retry-shaped failures. A second
 * retry-shaped failure aborts the whole admission as unavailable: an outage is
 * not a fact about the model, so nothing may be recorded from it.
 */
async function probeOnce(
    request: AdmissionRequest,
    probe: Omit<ModelRequest, "model" | "provider" | "signal">,
): Promise<IncompatibleOutcome | ProbeSuccess> {
    let lastUnavailable: string | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        request.signal?.throwIfAborted();
        const signals = [AbortSignal.timeout(PROBE_TIMEOUT_MS)];
        if (request.signal !== undefined) {
            signals.push(request.signal);
        }
        const outcome = await collectProbe(request.adapter.stream({
            ...probe,
            provider: request.provider,
            model: request.model,
            signal: AbortSignal.any(signals),
        }));
        if (outcome.failure === undefined) {
            if (
                outcome.message.stopReason === "error"
                || outcome.message.stopReason === "aborted"
            ) {
                lastUnavailable = outcome.message.errorMessage
                    ?? outcome.message.stopReason;
                continue;
            }
            return { kind: "success", message: outcome.message };
        }
        if (outcome.failure.resolution === "user_action") {
            return incompatible(
                outcome.failure.message,
                outcome.failure.statusCode,
            );
        }
        lastUnavailable = outcome.failure.message;
    }
    throw new AdmissionUnavailable(
        lastUnavailable ?? "provider did not answer the probe",
    );
}

function incompatible(
    reason: string,
    statusCode?: number,
): IncompatibleOutcome {
    return {
        kind: "incompatible",
        reason,
        verdict: {
            status: "incompatible",
            reason,
            ...(statusCode === undefined ? {} : { statusCode }),
        },
    };
}

async function collectProbe(
    stream: ModelStream,
): Promise<{
    message: AssistantMessage;
    failure?: ProviderFailureError["failure"];
}> {
    let message: AssistantMessage | undefined;
    let failure: ProviderFailureError["failure"] | undefined;
    for await (const event of stream) {
        if (event.type === "done") {
            message = event.message;
        } else if (event.type === "error") {
            message = event.message;
            if (event.error instanceof ProviderFailureError) {
                failure = event.error.failure;
            }
        }
    }
    if (message === undefined) {
        throw new AdmissionUnavailable("the probe stream ended without a result");
    }
    return failure === undefined ? { message } : { message, failure };
}

function stepReporter(
    request: AdmissionRequest,
    step: string,
    label: string,
): (status: AdmissionStepStatus, detail?: string) => void {
    request.onStep?.({ step, label, status: "running" });
    return (status, detail) => {
        request.onStep?.({
            step,
            label,
            status,
            ...(detail === undefined ? {} : { detail }),
        });
    };
}

/**
 * Maps a provider's level name onto Vera's effort ladder where the name is
 * recognizable, and otherwise keeps the provider's own word: the level list is
 * a fact about the model, not a fixed vocabulary.
 */
function veraEffortForLevel(providerEffort: string): ModelReasoningEffort {
    if (providerEffort === "none") return "off";
    if (providerEffort === "max" || providerEffort === "xhigh") return "max";
    return providerEffort;
}
