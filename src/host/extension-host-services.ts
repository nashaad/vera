import type { VeraConfig } from "../config.ts";
import {
    bindModelAssignment,
    type ReachabilityCheck,
} from "../config/model-assignments.ts";
import { createRoutedCompletionService } from "../engine/completion-service.ts";
import { contextWindowForModel } from "../engine/model-settings.ts";
import type { ExtensionHostServices } from "../extensions/host-services.ts";
import type { ModelAdapter } from "../model/types.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import { oneshotModelMessage } from "./agent-registry/helpers.ts";

export interface ExtensionHostServiceOptions {
    readonly registry: AgentRegistry;
    readonly currentConfig: () => VeraConfig;
    readonly reachability: () => ReachabilityCheck;
    readonly createAdapter: () => ModelAdapter;
}

export function createExtensionHostServices(
    options: ExtensionHostServiceOptions,
): ExtensionHostServices {
    return {
        async oneshot(call, signal) {
            const config = options.currentConfig();
            const binding = bindModelAssignment(
                {
                    models: config.models ?? [],
                    model_routes: config.model_routes ?? {},
                    reviewer_profiles: config.reviewer_profiles ?? {},
                },
                config.model_assignments ?? {},
                { assignment: call.assignment },
                options.reachability(),
            );
            // Never fall back to a session's model: an extension did not pick it.
            if (binding.models.length === 0) {
                throw new Error(
                    `No reachable model is assigned to ${call.assignment}`,
                );
            }
            const complete = createRoutedCompletionService(
                options.createAdapter(),
                {
                    models: binding.models.map((model) => {
                        const window = contextWindowForModel(
                            model.provider,
                            model.model,
                        );
                        return {
                            provider: model.provider,
                            model: model.model,
                            ...(model.reasoning_effort === undefined
                                ? {}
                                : { reasoningEffort: model.reasoning_effort }),
                            ...(window === undefined
                                ? {}
                                : { contextWindow: window }),
                        };
                    }),
                },
            );
            const result = await complete({
                systemPrompt: call.systemPrompt,
                messages: call.messages.map((message) =>
                    oneshotModelMessage({
                        role: message.role,
                        content: message.text,
                    })
                ),
                ...(call.maxTokens === undefined
                    ? {}
                    : { maxTokens: call.maxTokens }),
            }, signal);
            return {
                text: result.text,
                model: result.model,
                ...(result.provider === undefined
                    ? {}
                    : { provider: result.provider }),
            };
        },
        setSessionTitle(sessionId, title) {
            return options.registry.setTitleIfUnnamed(sessionId, title);
        },
    };
}
