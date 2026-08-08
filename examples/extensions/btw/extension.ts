// A side conversation, one way.
//
// `/btw <model> as <alias>` puts a second model beside the conversation. From
// then on `@alias` sends the message to that model and `@all` sends it to the
// model and the agent at once. A message with no `@` goes to the agent, every
// time: consulting a seat is something you ask for per message, not a mode you
// enter.
//
// One way is the whole contract. A seat reads the main thread, and nothing a
// seat says reaches the agent or another seat on its own. Automatic delivery
// was tried and removed: once every participant reads every other one, they
// converge, and a second opinion that agrees carries no information. Moving an
// answer across is the user's deliberate act, and it carries its own
// introduction when it happens.

const AGENT = "agent";

/** How much of the thread a seat is shown. Older turns fall off the end. */
const THREAD_TURNS = 12;

interface Seat {
    readonly alias: string;
    readonly model: string;
    /** Which provider serves this model. A seat is always fully addressed. */
    readonly provider: string;
    /** What this seat has been told and has said, in its own order. */
    readonly lane: { role: "user" | "assistant"; content: string }[];
}

export function activateClient(vera: any): void {
    const seats = new Map<string, Seat>();
    /** How many seats may be filled at once. One unless the config says more. */
    const maxSeats: number = vera.config?.maxSeats ?? 1;
    let sidebarOpen = false;
    let saidThreadUnreadable = false;
    /**
     * The seat every message goes to until told otherwise. Addressing one seat
     * per message is right for a second opinion and wrong for a conversation,
     * and a back-and-forth is what a seat turns into once its answer is worth
     * following up on.
     *
     * The composer says whose name it is while it is set, because a mode you
     * cannot see is a mode you send the wrong message in.
     */
    let sticky: string | undefined;

    /**
     * The pool entry a name refers to, by the user's own name for it or by the
     * model id. A seat can only be a model the user already admitted: an
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

    /** Empty the seat and say so where it spoke. */
    function removeSeat(alias: string): void {
        const seat = seats.get(alias)!;
        seats.delete(alias);
        if (sticky === alias) {
            stickTo(undefined);
        }
        if (sidebarOpen) {
            // The column says who is in the room, so it says when someone is
            // not: an ended lane should not read as one gone quiet.
            vera.ui.sidebar.append({
                label: `${alias} (${seat.model})`,
                text: "Left the conversation.",
            });
        }
        offerMentions();
        if (seats.size === 0 && sidebarOpen) {
            vera.ui.sidebar.close();
            sidebarOpen = false;
        }
    }

    /** Latch onto a seat, or let go and go back to the agent. */
    function stickTo(alias: string | undefined): void {
        sticky = alias;
        try {
            vera.ui.addressing.set(alias === undefined ? undefined : `@${alias}`);
        } catch {
            // This client cannot show who a message is for. The notice below
            // is then the only thing that says so, so it is not enough to
            // stay in a mode the user cannot see.
            if (alias !== undefined) {
                sticky = undefined;
                vera.ui.notice(
                    `This client cannot show a held address; use @${alias} `
                        + "on each message.",
                );
                return;
            }
        }
        vera.ui.notice(
            alias === undefined
                ? "Back to the agent."
                : `Holding @${alias}. @vera goes back to the agent.`,
        );
    }

    /** The composer completes these after an `@`. */
    function offerMentions(): void {
        try {
            vera.ui.mentions.set(
                seats.size === 0 ? [] : [...seats.keys(), "all", "vera"],
            );
        } catch {
            // This client does not complete mentions. Typing still works.
        }
    }

    /**
     * The seat's standing brief: who it is, plus the tail of the main thread.
     * It rides in the system prompt because a system prompt is replaced on
     * every call, never appended, so the thread cannot compound. The string is
     * deterministic for an unchanged thread, which keeps the provider's prompt
     * cache warm across back-to-back turns with the same seat.
     */
    function seatBrief(seat: Seat): string {
        const base = `You are ${seat.alias}, an advisor seated beside the `
            + "user's main agent. You are not that agent: the thread below is "
            + "someone else's conversation, so never take its name or speak "
            + "as it. You have no tools. Answer the user directly and "
            + "briefly; what you say reaches the agent only if the user "
            + "quotes it.";
        let turns: { role: string; text: string }[];
        try {
            turns = [...vera.thread.read()].slice(-THREAD_TURNS);
        } catch {
            // A client without the capability still works, but blind seats
            // are worth a sentence, once, rather than a silent degrade.
            if (!saidThreadUnreadable) {
                saidThreadUnreadable = true;
                vera.ui.notice(
                    "This client cannot share the thread; seats answer blind.",
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

    async function ask(seat: Seat, text: string): Promise<void> {
        // What was asked, beside what came back: the column is a conversation,
        // not a list of answers to questions that are somewhere else.
        if (sidebarOpen) {
            vera.ui.sidebar.append({
                label: `you \u2192 @${seat.alias}`,
                text,
                speaker: "you",
            });
        }
        seat.lane.push({ role: "user", content: text });
        try {
            const answer = await vera.consult({
                model: seat.model,
                provider: seat.provider,
                systemPrompt: seatBrief(seat),
                messages: seat.lane.map((turn) => ({ ...turn })),
            });
            seat.lane.push({ role: "assistant", content: answer.text });
            const block = {
                label: `${seat.alias} (${seat.model})`,
                text: answer.text,
                speaker: seat.alias,
            };
            // Beside the transcript when there is a sidebar to put it in, so
            // the thread stays readable while the seats talk.
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
            // Filed where the seat speaks, so a failed round reads in place
            // rather than as a notice about a column that stayed blank.
            if (sidebarOpen) {
                vera.ui.sidebar.append({
                    label: `${seat.alias} (${seat.model})`,
                    text: `Could not answer: ${reason}`,
                    speaker: seat.alias,
                });
            } else {
                vera.ui.notice(`${seat.alias} could not answer: ${reason}`);
            }
        }
    }

    /**
     * Both names run this. `/consult` says what it does; `/btw` is the
     * short one, and it is what the extension was called first.
     */
    function seat({ argumentsText }: { argumentsText: string }): void {
        const match = /^(\S+)(?:\s+as\s+(\S+))?$/.exec(argumentsText.trim());
        if (match === null) {
            throw new Error("Usage: /consult <model> as <alias>");
        }
        if (seats.size >= maxSeats) {
            throw new Error(
                `${maxSeats} side conversation${maxSeats === 1 ? "" : "s"} at a `
                    + "time. /remove <alias> frees one.",
            );
        }
        const requested = match[1]!;
        const entry = pooled(requested);
        if (entry === undefined) {
            throw new Error(
                `${requested} is not in the model pool. /model adds one.`,
            );
        }
        const model = entry.model;
        // `self` names where the model came from, not the seat: a column
        // headed "self" says nothing about who is in it.
        const alias = match[2]
            ?? (requested === "self" || requested === "default"
                ? model
                : requested);
        if (alias === AGENT || seats.has(alias)) {
            throw new Error(`${alias} is already taken`);
        }
        seats.set(alias, { alias, model, provider: entry.provider, lane: [] });
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
                label: `${alias} (${model})`,
                text: "Seated. Ask with @" + alias + ", or @all.",
            });
        }
        vera.ui.notice(`@${alias} is ${model}. @all asks everyone.`);
    }

    for (const name of ["consult", "btw"]) {
        vera.commands.register({
            name,
            description: "Ask another model, beside the conversation",
            usage: `/${name} <model> as <alias>`,
            arguments: "model",
            run: seat,
        });
    }

    vera.commands.register({
        name: "seats",
        description: "List the models in this conversation",
        usage: "/seats",
        run() {
            const rows = [...seats.values()].map((seat) =>
                `@${seat.alias} ${seat.model}`
            );
            vera.ui.notice(
                rows.length === 0
                    ? "No side conversations. /btw <model> as <alias> opens one."
                    : ["agent", ...rows].join(" · "),
            );
        },
    });

    vera.commands.register({
        name: "remove",
        description: "Remove a seat from this conversation",
        usage: "/remove <alias>",
        arguments: "mention",
        run({ argumentsText }: { argumentsText: string }) {
            const alias = argumentsText.trim();
            // The composer completes this argument from the same names it
            // completes an `@` from, and `all` is one of them.
            if (alias === "all" && !seats.has("all")) {
                for (const name of [...seats.keys()]) {
                    removeSeat(name);
                }
                vera.ui.notice("Every seat left");
                return;
            }
            if (!seats.has(alias)) {
                throw new Error(`No seat named ${alias}`);
            }
            removeSeat(alias);
            vera.ui.notice(`@${alias} left`);
        },
    });

    // A different conversation seats nobody: the seats belonged to the one
    // being left, and its sidebar is gone with it.
    vera.conversation.onChanged(() => {
        seats.clear();
        sidebarOpen = false;
        sticky = undefined;
        try {
            vera.ui.addressing.set(undefined);
        } catch {
            // Nothing was being shown.
        }
        offerMentions();
    });

    vera.messages.intercept((message: { text: string }) => {
        if (seats.size === 0) {
            return undefined;
        }
        // An address with nothing after it is not a message: it says where
        // the ones after it are going.
        const held = /^@(\S+)$/.exec(message.text.trim())?.[1];
        if (held !== undefined) {
            if (held === AGENT || held === "vera") {
                stickTo(undefined);
            } else if (held === "all") {
                // Everyone at once is something you ask for, not somewhere you
                // stay: held, it would make every message a broadcast.
                vera.ui.notice("@all asks everyone once; it is not held.");
            } else if (seats.has(held)) {
                stickTo(held);
            } else {
                vera.ui.notice(`No seat named @${held}`);
            }
            return { kind: "handled" };
        }

        const addressed = /^@(\S+)\s+([\s\S]+)$/.exec(message.text);
        const target = addressed?.[1] ?? sticky;
        const text = addressed?.[2] ?? message.text;

        if (target === "all") {
            for (const seat of seats.values()) void ask(seat, text);
            // The agent is one of everyone, and it gets the user's own words
            // with nothing added: `@all` is one message to several places, not
            // a round of introductions.
            return { kind: "replace", text };
        }
        if (target !== undefined && seats.has(target)) {
            void ask(seats.get(target)!, text);
            return { kind: "handled" };
        }
        if (addressed !== null && (target === AGENT || target === "vera")) {
            // Named the agent for one message. The name was addressing, not
            // words, so it does not travel with them.
            return { kind: "replace", text };
        }
        if (target !== undefined && target !== AGENT && target !== "vera") {
            // Held rather than passed through: a typo'd alias sent to the
            // agent is the one outcome nobody wanted.
            vera.ui.notice(`No seat named @${target}`);
            return { kind: "handled" };
        }
        return undefined;
    });
}
