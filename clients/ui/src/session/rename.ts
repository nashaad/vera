import { askSession } from "../composer/slash/host.ts";
import { parseSlashReply, renameLine } from "../composer/slash/wire.ts";
import { freshRequestId } from "../composer/requests.ts";
import type { ActiveSession } from "./activeSession.ts";

// The host keeps names to 200 bytes of text with no NUL; it answers "invalid" otherwise.
const REJECTION_TEXT: Readonly<Record<string, string>> = {
    invalid: "That is not a usable session name. Use 1 to 200 characters.",
    unavailable: "This session cannot be renamed.",
};

export type RenameResult =
    | { readonly ok: true; readonly name: string | null }
    | { readonly ok: false; readonly message: string };

export async function renameSession(
    session: Pick<ActiveSession, "bridge" | "agentId" | "send">,
    name: string | null,
): Promise<RenameResult> {
    const requestId = freshRequestId("rename");
    const reply = await askSession(session, requestId, renameLine(requestId, name), (text) => {
        const parsed = parseSlashReply(text);
        return parsed?.type === "renamed" || parsed?.type === "rename_rejected" ? parsed : undefined;
    });
    if (reply === undefined) return { ok: false, message: "The session did not answer in time" };
    if (reply.type === "rename_rejected") {
        return { ok: false, message: REJECTION_TEXT[reply.reason] ?? "The session could not be renamed." };
    }
    return { ok: true, name: reply.name };
}
