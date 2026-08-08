// One thread, several models.
//
// `/add <model> as <alias>` puts a second model in the conversation. From then
// on `@alias` sends the message to that model, `@all` sends it to every model
// at once, and a bare message goes to whoever answered last.
//
// The extra seats advise: they have no tools and nothing they say is written
// to the session. What reaches the agent is the next message you write, with
// the replies you have not answered yet quoted above it. Merging is a thing
// you do by writing, not something this decides for you.

const AGENT = "agent";

interface Seat {
    readonly alias: string;
    readonly model: string;
    /** What this seat has been told and has said, in its own order. */
    readonly lane: { role: "user" | "assistant"; content: string }[];
}

export function activateClient(vera: any): void {
    const seats = new Map<string, Seat>();
    let sidebarOpen = false;
    /** Replies each participant has not been shown yet, oldest first. */
    const unread = new Map<string, string[]>([[AGENT, []]]);
    let incumbent = AGENT;

    function takeUnread(participant: string): string {
        const waiting = unread.get(participant) ?? [];
        if (waiting.length === 0) return "";
        unread.set(participant, []);
        return `${waiting.join("\n\n")}\n\n`;
    }

    function fileReply(from: string, model: string, text: string): void {
        const quoted = `[${from} (${model}) replied:]\n${text}`;
        for (const participant of unread.keys()) {
            if (participant !== from) {
                unread.get(participant)!.push(quoted);
            }
        }
    }

    async function ask(seat: Seat, text: string): Promise<void> {
        seat.lane.push({
            role: "user",
            content: `${takeUnread(seat.alias)}${text}`,
        });
        try {
            const answer = await vera.consult({
                model: seat.model,
                messages: seat.lane.map((turn) => ({ ...turn })),
            });
            seat.lane.push({ role: "assistant", content: answer.text });
            fileReply(seat.alias, seat.model, answer.text);
            const block = {
                label: `${seat.alias} (${seat.model})`,
                text: answer.text,
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
                });
            } else {
                vera.ui.notice(`${seat.alias} could not answer: ${reason}`);
            }
        }
    }

    vera.commands.register({
        name: "add",
        description: "Add a model to this conversation as another seat",
        usage: "/add <model> as <alias>",
        arguments: "model",
        run({ argumentsText }: { argumentsText: string }) {
            const match = /^(\S+)(?:\s+as\s+(\S+))?$/.exec(argumentsText.trim());
            if (match === null) {
                throw new Error("Usage: /add <model> as <alias>");
            }
            const model = match[1]!;
            const alias = match[2] ?? model;
            if (alias === AGENT || seats.has(alias)) {
                throw new Error(`${alias} is already taken`);
            }
            seats.set(alias, { alias, model, lane: [] });
            unread.set(alias, []);
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
        },
    });

    vera.commands.register({
        name: "seats",
        description: "List the models in this conversation",
        usage: "/seats",
        run() {
            const rows = [...seats.values()].map((seat) =>
                `@${seat.alias} ${seat.model}${
                    incumbent === seat.alias ? " (incumbent)" : ""
                }`
            );
            vera.ui.notice(
                rows.length === 0
                    ? "No extra seats. /add <model> as <alias> adds one."
                    : [
                        `agent${incumbent === AGENT ? " (incumbent)" : ""}`,
                        ...rows,
                    ].join(" · "),
            );
        },
    });

    vera.commands.register({
        name: "drop",
        description: "Remove a seat from this conversation",
        usage: "/drop <alias>",
        run({ argumentsText }: { argumentsText: string }) {
            const alias = argumentsText.trim();
            if (!seats.delete(alias)) {
                throw new Error(`No seat named ${alias}`);
            }
            unread.delete(alias);
            if (incumbent === alias) incumbent = AGENT;
            if (seats.size === 0 && sidebarOpen) {
                vera.ui.sidebar.close();
                sidebarOpen = false;
            }
            vera.ui.notice(`@${alias} left`);
        },
    });

    vera.messages.intercept((message: { text: string }) => {
        if (seats.size === 0) return undefined;
        const addressed = /^@(\S+)\s+([\s\S]+)$/.exec(message.text);
        const target = addressed?.[1];
        const text = addressed?.[2] ?? message.text;

        if (target === "all") {
            for (const seat of seats.values()) void ask(seat, text);
            incumbent = AGENT;
            return { kind: "replace", text: `${takeUnread(AGENT)}${text}` };
        }
        if (target !== undefined && seats.has(target)) {
            incumbent = target;
            void ask(seats.get(target)!, text);
            return { kind: "handled" };
        }
        if (target !== undefined && target !== AGENT) {
            // Held rather than passed through: a typo'd alias sent to the
            // agent is the one outcome nobody wanted.
            vera.ui.notice(`No seat named @${target}`);
            return { kind: "handled" };
        }
        if (target === AGENT) incumbent = AGENT;
        if (incumbent !== AGENT) {
            void ask(seats.get(incumbent)!, text);
            return { kind: "handled" };
        }
        return { kind: "replace", text: `${takeUnread(AGENT)}${text}` };
    });
}
