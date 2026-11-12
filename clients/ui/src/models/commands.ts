// Lines for the session's watch connection that read or change its model settings.

export function getModelSettingsCommand(requestId: string): string {
    return line({ type: "get_model_settings", requestId });
}

// Runs the model in this session and makes it the default for new sessions.
// A missing effort leaves the choice to the host; `null` asks for the model's own default.
export function switchModelCommand(requestId: string, provider: string | undefined, model: string, effort?: string | null): string {
    const patch = {
        ...(provider === undefined ? {} : { provider }),
        model,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
    };
    return line({ type: "update_model_settings", requestId, patch });
}

export function effortCommand(requestId: string, effort: string | null): string {
    return line({ type: "update_model_settings", requestId, patch: { reasoningEffort: effort } });
}

function line(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}
