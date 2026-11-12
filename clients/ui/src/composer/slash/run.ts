import { parseCatalogLine, selectAgentCommand } from "../../customize/wire.ts";
import { OVERLAY_COMMANDS } from "../../commands/overlay-ids.ts";
import { freshRequestId } from "../requests.ts";
import { askSession, type SlashSession } from "./host.ts";
import { notImplementedMessage, type SlashEntry } from "./model.ts";
import { requestPill } from "./pillRequests.ts";
import { invokeSkillLine, parseSlashReply, runExtensionCommandLine } from "./wire.ts";

export interface SlashRunContext {
    // Undefined on New Chat, where there is no session to ask.
    readonly session: SlashSession | undefined;
    readonly run: (command: string, args?: unknown) => void;
    // Shows one sentence under the composer.
    readonly notify: (text: string) => void;
    // Puts the typed line back when the box is empty again, after a command did not go through.
    readonly restore: () => void;
}

export const EXTENSION_BUSY = "Extension commands are available when the agent is idle";
const NO_ANSWER = "The session did not answer in time";

// Runs one slash command. Everything it needs from the host goes through the session's own connection.
export async function runSlashEntry(entry: SlashEntry, args: string, context: SlashRunContext): Promise<void> {
    const { action } = entry;
    switch (action.kind) {
        case "unsupported":
            context.notify(notImplementedMessage(entry));
            return;
        case "command":
            if (action.needsSession === true && context.session === undefined) {
                context.notify(`/${entry.name} needs an open session`);
                return;
            }
            context.run(action.id, args.length > 0 ? args : undefined);
            return;
        case "pill": {
            const result = requestPill(action.pill, args);
            if (!result.done) context.notify(result.message);
            return;
        }
        case "agent":
            await runAgent(args, context);
            return;
        case "extension":
            await runExtension(entry, args, context);
            return;
        case "skill":
            await runSkill(entry, args, context);
            return;
    }
}

async function runAgent(name: string, context: SlashRunContext): Promise<void> {
    const { session } = context;
    if (name.length === 0) {
        context.run(OVERLAY_COMMANDS.agent.id);
        return;
    }
    if (session === undefined) {
        context.notify("/agent needs an open session");
        return;
    }
    const requestId = freshRequestId("select-agent");
    const reply = await askSession(session, requestId, selectAgentCommand(requestId, name), parseCatalogLine);
    if (reply?.type === "agent_selected") context.notify(reply.notice ?? `Agent: ${reply.name}`);
    else if (reply?.type === "agent_rejected") context.notify(reply.reason);
    else context.notify(NO_ANSWER);
}

async function runExtension(entry: SlashEntry, args: string, context: SlashRunContext): Promise<void> {
    const { session } = context;
    if (session === undefined) {
        context.notify(`/${entry.name} needs an open session`);
        return;
    }
    if (session.running) {
        context.notify(EXTENSION_BUSY);
        context.restore();
        return;
    }
    const requestId = freshRequestId("slash-extension");
    const reply = await askSession(session, requestId, runExtensionCommandLine(requestId, entry.name, args), parseSlashReply);
    if (reply?.type === "extension_result") {
        context.notify(reply.text);
    } else if (reply?.type === "extension_failed") {
        context.notify(reply.text);
        context.restore();
    } else {
        context.notify(NO_ANSWER);
        context.restore();
    }
}

// The host starts the skill as a turn, or queues it behind the running one; the transcript shows it.
async function runSkill(entry: SlashEntry, args: string, context: SlashRunContext): Promise<void> {
    const { session } = context;
    if (session === undefined) {
        context.notify(`/${entry.name} needs an open session`);
        return;
    }
    const requestId = freshRequestId("slash-skill");
    const reply = await askSession(session, requestId, invokeSkillLine(requestId, entry.name, args), parseSlashReply);
    if (reply?.type === "skill_accepted") {
        if (reply.queued) context.notify(`/${entry.name} will run when this turn ends`);
    } else if (reply?.type === "skill_rejected") {
        context.notify(reply.reason);
        context.restore();
    } else {
        context.notify(NO_ANSWER);
        context.restore();
    }
}
