// A side conversation, one way.
//
// `/sidekick [model]` puts a second model beside the conversation, always
// called the sidekick. From then on `@sidekick` sends the message to it and
// `@all` sends it to the sidekick and the agent at once. A message with no
// `@` goes to the agent, every time: consulting the sidekick is something you
// ask for per message, not a mode you enter.
//
// There is one seat, and its name is fixed. A name you chose is a name you
// have to remember, and with a single seat it buys nothing: what varies is
// which model is sitting in it, and the column says that already.
//
// One way is the whole contract. The sidekick reads the main thread, and
// nothing it says reaches the agent on its own. Automatic delivery was tried
// and removed: once every participant reads every other one, they converge,
// and a second opinion that agrees carries no information. Moving an answer
// across is the user's deliberate act, and it carries its own introduction
// when it happens.

const AGENT = "agent";

/** The one seat's name. Fixed, because there is only ever one. */
const SIDEKICK = "sidekick";

/** How much of the thread the sidekick is shown. Older turns fall off the end. */
const THREAD_TURNS = 12;

interface Seat {
    readonly model: string;
    /** Which provider serves this model. A seat is always fully addressed. */
    readonly provider: string;
    /** What the sidekick has been told and has said, in its own order. */
    readonly lane: { role: "user" | "assistant"; content: string }[];
}

export function activateClient(vera: any): void {
    let seat: Seat | undefined;
    let sidebarOpen = false;
    let saidThreadUnreadable = false;
    /**
     * Whether every message goes to the sidekick until told otherwise.
     * Addressing it per message is right for a second opinion and wrong for a
     * conversation, and a back-and-forth is what the seat turns into once its
     * answer is worth following up on.
     *
     * The composer says so while it is set, because a mode you cannot see is
     * a mode you send the wrong message in.
     */
    let sticky = false;

    /**
     * The pool entry a name refers to, by the user's own name for it or by the
     * model id. The seat can only be a model the user already admitted: an
     * ad-hoc id has no provider behind it, so it would be sent to whichever
     * provider happens to be the default and be rejected there.
     */
    function pooled(name: string): { model: string; provider: string } | undefined {
        const settings = vera.modelSettings.current();
        // The model this conversation is already using. A second copy of it is
        // the common case, and it is the only model the user is certain works
        // here, so it has a name that does not have to be looked up.
        if (name === "self" || name === "default") {
            return settings === undefined
                ? undefined
                : { model: settings.model, provider: settings.provider };
        }
        const entries = settings?.pooled ?? [];
        const match = entries.find((entry: any) =>
            entry.poolName === name || entry.model === name
            || `${entry.provider}/${entry.model}` === name
        );
        return match === undefined
            ? undefined
            : { model: match.model, provider: match.provider };
    }

    /**
     * Empty the seat. The column goes with it, so a farewell written into the
     * column would be shown to nobody: the notice is what says it left.
     */
    function removeSeat(): void {
        seat = undefined;
        stickTo(false);
        offerMentions();
        if (sidebarOpen) {
            vera.ui.sidebar.close();
            sidebarOpen = false;
        }
    }

    /** Latch onto the sidekick, or let go and go back to the agent. */
    function stickTo(held: boolean): void {
        sticky = held;
        try {
            vera.ui.addressing.set(held ? `@${SIDEKICK}` : undefined);
        } catch {
            // This client cannot show who a message is for. The notice below
            // is then the only thing that says so, so it is not enough to
            // stay in a mode the user cannot see.
            if (held) {
                sticky = false;
                vera.ui.notice(
                    `This client cannot show a held address; use @${SIDEKICK} `
                        + "on each message.",
                );
                return;
            }
        }
        // Short, because the client keeps the standing version of this in
        // view: the notice marks the change, not the state.
        vera.ui.notice(held ? `Holding @${SIDEKICK}.` : "Back to the agent.");
    }

    /** The composer completes these after an `@`. */
    function offerMentions(): void {
        try {
            vera.ui.mentions.set(
                seat === undefined ? [] : [SIDEKICK, "all", "vera"],
            );
        } catch {
            // This client does not complete mentions. Typing still works.
        }
    }

    /**
     * The sidekick's standing brief: who it is, plus the tail of the main
     * thread. It rides in the system prompt because a system prompt is
     * replaced on every call, never appended, so the thread cannot compound.
     * The string is deterministic for an unchanged thread, which keeps the
     * provider's prompt cache warm across back-to-back turns.
     */
    function seatBrief(): string {
        const base = `You are the ${SIDEKICK}, an advisor seated beside the `
            + "user's main agent. You are not that agent: the thread below is "
            + "someone else's conversation, so never take its name or speak "
            + "as it. You have no tools. Answer the user directly and "
            + "briefly; what you say reaches the agent only if the user "
            + "quotes it.";
        let turns: { role: string; text: string }[];
        try {
            turns = [...vera.thread.read()].slice(-THREAD_TURNS);
        } catch {
            // A client without the capability still works, but a blind seat
            // is worth a sentence, once, rather than a silent degrade.
            if (!saidThreadUnreadable) {
                saidThreadUnreadable = true;
                vera.ui.notice(
                    "This client cannot share the thread; the sidekick answers blind.",
                );
            }
            return base;
        }
        if (turns.length === 0) {
            return base;
        }
        const thread = turns
            .map((turn) => `${turn.role === "user" ? "User" : "Agent"}: ${turn.text}`)
            .join("\n\n");
        return `${base}\n\nThe main thread so far, most recent last:\n\n${thread}`;
    }

    async function ask(current: Seat, text: string): Promise<void> {
        // What was asked, beside what came back: the column is a conversation,
        // not a list of answers to questions that are somewhere else.
        if (sidebarOpen) {
            vera.ui.sidebar.append({
                label: `you → @${SIDEKICK}`,
                text,
                speaker: "you",
            });
        }
        current.lane.push({ role: "user", content: text });
        try {
            const answer = await vera.consult({
                model: current.model,
                provider: current.provider,
                systemPrompt: seatBrief(),
                messages: current.lane.map((turn) => ({ ...turn })),
            });
            current.lane.push({ role: "assistant", content: answer.text });
            const block = {
                label: `${SIDEKICK} (${current.model})`,
                text: answer.text,
                speaker: SIDEKICK,
            };
            // Beside the transcript when there is a sidebar to put it in, so
            // the thread stays readable while the sidekick talks.
            if (sidebarOpen) {
                vera.ui.sidebar.append(block);
            } else {
                vera.ui.transcript(block);
            }
        } catch (error) {
            // The seat keeps its lane: a failed round is a gap, not a reset.
            const reason = error instanceof Error
                ? error.message
                : String(error);
            // Filed where the sidekick speaks, so a failed round reads in
            // place rather than as a notice about a column that stayed blank.
            if (sidebarOpen) {
                vera.ui.sidebar.append({
                    label: `${SIDEKICK} (${current.model})`,
                    text: `Could not answer: ${reason}`,
                    speaker: SIDEKICK,
                });
            } else {
                vera.ui.notice(`The ${SIDEKICK} could not answer: ${reason}`);
            }
        }
    }

    /**
     * Both names run this. `/sidekick` is the command and the seat under one
     * word; `/btw` is the short one, and it is what the extension was called
     * first.
     */
    function seatCommand({ argumentsText }: { argumentsText: string }): void {
        const typed = argumentsText.trim();
        // No model named means the one already answering.
        const requested = typed === "" ? "self" : typed;
        if (/\s/.test(requested)) {
            throw new Error("Usage: /sidekick <model>");
        }
        if (seat !== undefined) {
            throw new Error(
                `The ${SIDEKICK} is ${seat.model}. /remove frees the seat.`,
            );
        }
        const entry = pooled(requested);
        if (entry === undefined) {
            throw new Error(
                `${requested} is not in the model pool. /model adds one.`,
            );
        }
        seat = { model: entry.model, provider: entry.provider, lane: [] };
        offerMentions();
        if (!sidebarOpen) {
            try {
                vera.ui.sidebar.open();
                sidebarOpen = true;
            } catch {
                // Another extension has it, or this client has none. The
                // replies land in the transcript instead.
            }
        }
        if (sidebarOpen) {
            // An empty column says nothing about who is in the room.
            vera.ui.sidebar.append({
                label: `${SIDEKICK} (${entry.model})`,
                text: `Seated. Ask with @${SIDEKICK}, or @all.`,
            });
        }
        vera.ui.notice(
            `@${SIDEKICK} is ${entry.model}. @all asks it and the agent.`,
        );
    }

    for (const name of [SIDEKICK, "btw"]) {
        vera.commands.register({
            name,
            description: "Seat another model beside the conversation",
            usage: `/${name} [model]`,
            arguments: "model",
            run: seatCommand,
        });
    }

    vera.commands.register({
        name: "reset",
        description: "Clear what the sidekick remembers",
        usage: "/reset",
        run() {
            if (seat === undefined) {
                throw new Error(`No ${SIDEKICK}. /${SIDEKICK} [model] seats one.`);
            }
            seat.lane.length = 0;
            // The column and the lane are the same conversation, so a column
            // still showing turns the model no longer remembers is a lie.
            if (sidebarOpen) {
                vera.ui.sidebar.clear();
                vera.ui.sidebar.append({
                    label: `${SIDEKICK} (${seat.model})`,
                    text: `Fresh start. Ask with @${SIDEKICK}, or @all.`,
                });
            }
            vera.ui.notice(`@${SIDEKICK} starts over`);
        },
    });

    vera.commands.register({
        name: "remove",
        description: "Send the sidekick away",
        usage: "/remove",
        run() {
            if (seat === undefined) {
                throw new Error(
                    `No ${SIDEKICK}. /${SIDEKICK} [model] seats one.`,
                );
            }
            removeSeat();
            vera.ui.notice(`@${SIDEKICK} left`);
        },
    });

    // A different conversation seats nobody: the seat belonged to the one
    // being left, and its sidebar is gone with it.
    vera.conversation.onChanged(() => {
        seat = undefined;
        sidebarOpen = false;
        sticky = false;
        try {
            vera.ui.addressing.set(undefined);
        } catch {
            // Nothing was being shown.
        }
        offerMentions();
    });

    vera.messages.intercept((message: { text: string }) => {
        const current = seat;
        if (current === undefined) {
            return undefined;
        }
        // An address with nothing after it is not a message: it says where
        // the ones after it are going.
        const held = /^@(\S+)$/.exec(message.text.trim())?.[1];
        if (held !== undefined) {
            if (held === AGENT || held === "vera") {
                stickTo(false);
            } else if (held === "all") {
                // Everyone at once is something you ask for, not somewhere you
                // stay: held, it would make every message a broadcast.
                vera.ui.notice("@all asks everyone once; it is not held.");
            } else if (held === SIDEKICK) {
                stickTo(true);
            } else {
                vera.ui.notice(`No seat named @${held}`);
            }
            return { kind: "handled" };
        }

        const addressed = /^@(\S+)\s+([\s\S]+)$/.exec(message.text);
        const target = addressed?.[1] ?? (sticky ? SIDEKICK : undefined);
        const text = addressed?.[2] ?? message.text;

        if (target === "all") {
            void ask(current, text);
            // The agent is one of everyone, and it gets the user's own words
            // with nothing added: `@all` is one message to two places, not a
            // round of introductions.
            return { kind: "replace", text };
        }
        if (target === SIDEKICK) {
            void ask(current, text);
            return { kind: "handled" };
        }
        if (addressed !== null && (target === AGENT || target === "vera")) {
            // Named the agent for one message. The name was addressing, not
            // words, so it does not travel with them.
            return { kind: "replace", text };
        }
        if (target !== undefined && target !== AGENT && target !== "vera") {
            // Held rather than passed through: a mistyped name sent to the
            // agent is the one outcome nobody wanted.
            vera.ui.notice(`No seat named @${target}`);
            return { kind: "handled" };
        }
        return undefined;
    });
}
