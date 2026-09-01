export class UserFacingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UserFacingError";
    }
}

export class ProviderUnavailableError extends UserFacingError {
    constructor(readonly provider: string) {
        super(`Session provider "${provider}" is unavailable in this Vera build`);
        this.name = "ProviderUnavailableError";
    }
}

export function userFacingMessage(error: unknown): string | undefined {
    return error instanceof UserFacingError ? error.message : undefined;
}
