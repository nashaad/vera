/**
 * An error whose message was written for the person running Vera.
 *
 * The host refuses to send error text over its socket, because most of it is
 * internal detail that a client has no business rendering. That default is
 * right, but it flattens the failures that were phrased for a user in the first
 * place: "No credentials for provider openrouter. Connect it from the model pane
 * (ctrl+e)" reached the terminal as "Resident agent create failed".
 *
 * Throwing this instead is the author saying the message is meant to be read,
 * which is the one thing the host cannot work out for itself.
 */
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

/** The message to show, or nothing when the failure was not written for a user. */
export function userFacingMessage(error: unknown): string | undefined {
    return error instanceof UserFacingError ? error.message : undefined;
}
