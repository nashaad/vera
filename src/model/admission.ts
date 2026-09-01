
import type { CatalogModel } from "./catalog-shape.ts";
import {
    isEffortLevel,
    type EffortLevel,
} from "./effort-ladder.ts";
import {
    IMAGES_LEARNED_KEY,
    PROBE_LEARNED_KEY,
    TOOLS_LEARNED_KEY,
    type LearnedFact,
    type LearnedFacts,
    effortLearnedKey,
} from "./pool-file.ts";
import { classifyCapabilityRejection } from "./capability-rejection.ts";
import {
    ProviderFailureError,
    type ProviderFailure,
} from "./provider-failure.ts";
import type {
    AssistantMessage,
    ModelAdapter,
    ModelRequest,
    ModelStream,
} from "./types.ts";

const PROBE_SENTINEL = "vera-admission-ok";
const PROBE_MAX_TOKENS = 2_048;
const PROBE_TIMEOUT_MS = 60_000;
const PROBE_TOOL_NAME = "admission_probe";

const PROBE_IMAGE = Uint8Array.fromBase64(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4"
    + "2mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
);

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
    readonly catalogModel?: CatalogModel;
    readonly checked?: "user_key" | "vera";
    readonly onStep?: (step: AdmissionStep) => void;
    readonly signal?: AbortSignal;
    readonly now?: () => Date;
}

export type AdmissionVerdict =
    | {
        readonly status: "added";
        readonly learned: LearnedFacts;
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
    const candidates = probeCandidates(request.catalogModel);
    const learned: Record<string, LearnedFact> = {};
    const verified: string[] = [];
    const dropped: string[] = [];
    const seen = (request.now?.() ?? new Date()).toISOString();
    const checked = request.checked ?? "user_key";
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

    for (const candidate of candidates) {
        const step = stepReporter(
            request,
            `level:${candidate.wire}`,
            `Reasoning ${candidate.level}`,
        );
        const outcome = await probeText(request, candidate.wire);
        if (outcome.kind === "incompatible") {
            step("failed", outcome.reason);
            dropped.push(candidate.wire);
            learned[effortLearnedKey(candidate.level)] = {
                ok: false,
                seen,
                error: outcome.reason,
                checked,
            };
            continue;
        }
        responseModel ??= outcome.responseModel;
        verified.push(candidate.wire);
        learned[effortLearnedKey(candidate.level)] = {
            ok: true,
            seen,
            wire: candidate.wire,
            checked,
        };
        step("passed");
    }

    if (candidates.length > 0 && verified.length === 0) {
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
        verified[0],
    );
    if (toolOutcome !== undefined) {
        toolStep("failed", toolOutcome.reason);
        return toolOutcome.verdict;
    }
    toolStep("passed");

    const imageStep = stepReporter(request, "image", "Accepts an image");
    const imageOutcome = await probeImage(request, verified[0]);
    if (imageOutcome !== undefined) {
        learned[IMAGES_LEARNED_KEY] = imageOutcome.ok
            ? { ok: true, seen, checked }
            : { ok: false, seen, error: imageOutcome.reason, checked };
        imageStep(
            imageOutcome.ok ? "passed" : "failed",
            ...(imageOutcome.ok ? [] : [imageOutcome.reason]),
        );
    } else {
        imageStep("skipped");
    }

    return {
        status: "added",
        learned: {
            ...learned,
            [PROBE_LEARNED_KEY]: {
                ok: true,
                seen,
                checked,
                ...(responseModel === undefined ? {} : { wire: responseModel }),
            },
            [TOOLS_LEARNED_KEY]: { ok: true, seen, checked },
        },
        droppedLevels: dropped,
    };
}

interface IncompatibleOutcome {
    readonly kind: "incompatible";
    readonly reason: string;
    readonly verdict: AdmissionVerdict & { readonly status: "incompatible" };
    readonly failure?: ProviderFailure;
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

async function probeImage(
    request: AdmissionRequest,
    providerEffort: string | undefined,
): Promise<{ readonly ok: true } | {
    readonly ok: false;
    readonly reason: string;
} | undefined> {
    let result;
    try {
        result = await probeOnce(request, {
            maxTokens: PROBE_MAX_TOKENS,
            ...(providerEffort === undefined
                ? {}
                : { reasoningEffort: providerEffort }),
            messages: [{
                role: "user",
                content: [
                    { type: "text", text: "Reply with one word." },
                    {
                        type: "image",
                        mediaType: "image/png",
                        data: PROBE_IMAGE,
                    },
                ],
            }],
        });
    } catch (error) {
        request.signal?.throwIfAborted();
        if (!(error instanceof AdmissionUnavailable)) {
            throw error;
        }
        return undefined;
    }
    if (result.kind !== "incompatible") {
        return { ok: true };
    }
    if (
        result.failure === undefined
        || classifyCapabilityRejection(result.failure)?.parameter !== "images"
    ) {
        return undefined;
    }
    return { ok: false, reason: result.reason };
}

interface ProbeSuccess {
    readonly kind: "success";
    readonly message: AssistantMessage;
}

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
                outcome.failure,
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
    failure?: ProviderFailure,
): IncompatibleOutcome {
    return {
        kind: "incompatible",
        reason,
        verdict: {
            status: "incompatible",
            reason,
            ...(statusCode === undefined ? {} : { statusCode }),
        },
        ...(failure === undefined ? {} : { failure }),
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

interface ProbeCandidate {
    readonly level: EffortLevel;
    readonly wire: string;
}

function probeCandidates(
    catalogModel: CatalogModel | undefined,
): readonly ProbeCandidate[] {
    return (catalogModel?.levels ?? []).flatMap((level) => {
        const rung = ladderLevelForWire(level.id);
        return rung === undefined || rung === "off"
            ? []
            : [{ level: rung, wire: level.id }];
    });
}

export function ladderLevelForWire(
    providerEffort: string,
): EffortLevel | undefined {
    if (providerEffort === "none") {
        return "off";
    }
    return isEffortLevel(providerEffort) ? providerEffort : undefined;
}
