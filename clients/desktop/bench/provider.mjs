// Scripted chat-completions SSE provider for the desktop rendering benchmark; every reply is a pure function of the request.
import { createServer } from "node:http";

const MODEL = "crow-0";
const SEED_CHUNK_GAP_MS = 0;
const STREAM_DELAY_MS = 1500;
const STREAM_STEP_MS = 10;
const STREAM_DELTA_CHARS = 6;
const STREAM_LENGTH = 7200;
// Call IDs must be unique across the whole run, not per reply.
let callCount = 0;

export function startBenchProvider() {
    const server = createServer((request, response) => {
        if (request.method === "GET" && request.url.endsWith("/models")) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ data: [{ id: MODEL }] }));
            return;
        }
        let raw = "";
        request.on("data", (part) => { raw += part; });
        request.on("end", () => handle(JSON.parse(raw), response));
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            resolve({
                port,
                close: () => new Promise((done) => {
                    server.closeAllConnections();
                    server.close(done);
                }),
            });
        });
    });
}

export function seedText(n) {
    const bullets = [];
    for (let k = 1; k <= 6; k += 1) {
        bullets.push(`- Item ${k} for seed ${n}: batch ${(n * 11 + k * 5) % 97} is logged and the crew has signed for it.`);
    }
    return [
        `### Seed ${n}`,
        "",
        `Seed ${n} opens the ledger for the harbor crew. The lamps on the north pier were trimmed before the evening tide, and the rope store counted ${n % 9 + 3} coils that matched the morning sheet. Ledger entry ${(n * 7) % 97} sits beside batch ${(n * 13) % 61}, and the review for that batch lists ${n % 5 + 2} open items that the crew will close before the next tide turns and the cargo moves.`,
        "",
        ...bullets,
        "",
        "```js",
        `const seed = ${n};`,
        "const crew = [\"Mara\", \"Tobias\", \"Ines\", \"Wen\"];",
        "function tally(values) {",
        "    return values.reduce((sum, value) => sum + value, 0);",
        "}",
        `const total = tally([seed, crew.length, ${(n * 3) % 17}]);`,
        "console.log(\"seed\", seed, \"total\", total);",
        "export default total;",
        "```",
        "",
        `The count for seed ${n} is recorded above, and the next seed starts from the same list of stores. The foreman signs each count at the end of the shift, and the signed sheet is copied into the ledger beside the entry it belongs to. Nothing in this reply depends on the time of day or on the state of the harbor, so a second run of the same seeds produces the same transcript, the same blocks and the same row heights in the view. Any difference between two runs therefore comes from the app itself, which is what this record is meant to show.`,
    ].join("\n");
}

export function writeContent(n) {
    const lines = [];
    for (let k = 1; k <= 12; k += 1) {
        lines.push(`line ${k} of seed ${n}: ${(n * 31 + k * 17) % 1000}`);
    }
    return lines.join("\n") + "\n";
}

export function streamText() {
    const sections = [
        "## Harbor report",
        "",
        "The harbor ledger for the week covers three piers, two cargo sheds and one shared tool room. Each section below repeats the same shape: a short summary, a list of items the crew checked, and a small script that sums the counts. The numbers are fixed so that two runs render the same text.",
        "",
        "### Pier inventory",
        "",
        "- North pier: six lamps trimmed, two lamps replaced, rope store at eleven coils.",
        "- South pier: four crates moved to the upper shed, one crate left for the morning tide.",
        "- Ferry dock: two tarps mended, the bollard paint is still wet on the east side.",
        "- Tool room: the saw is back on its hook, the spare pulleys are counted and logged.",
        "- Shed one: humidity at sixty percent, the grain sacks stay on the pallets.",
        "- Shed two: the seal on the fuel drum held through the storm and needs no work.",
        "",
        "Pier inventory closes with the same counts the crew reported at the morning bell. Any change after that point goes into the next ledger, and the night watch initials each change in the margin.",
        "",
        "```js",
        "const piers = [\"north\", \"south\", \"ferry\"];",
        "const counts = { north: 8, south: 5, ferry: 3 };",
        "function sumCounts(map) {",
        "    return Object.values(map).reduce((sum, value) => sum + value, 0);",
        "}",
        "const total = sumCounts(counts);",
        "console.log(\"piers\", piers.length, \"items\", total);",
        "```",
        "",
        "### Tide log",
        "",
        "The tide log records the water level at six points in the day, from the first light at the north pier to the last check at the ferry dock. Each reading carries the same fields: the hour, the level in feet, the wind from the harbor mouth and the name of the watch that took it. The readings stay in one place so that the crew can compare a bad day against a calm one without opening the older ledgers.",
        "",
        "- Dawn reading: level at four feet, wind light from the southwest, watch Ines.",
        "- Morning reading: level at five feet, wind steady, the ferry ramp clear of weed.",
        "- Noon reading: level at five and a half feet, two skiffs moved to the inner mooring.",
        "- Afternoon reading: level falling, wind backing to the west, the gate chain checked.",
        "- Dusk reading: level at four feet, the lamps on the north pier lit and tested.",
        "- Night reading: level steady, the watch logged no change through the small hours.",
        "",
        "The tide log is read by the morning crew before any cargo is moved. A reading that differs from the forecast by more than half a foot triggers a second check at the nearest pier, and the result is written beside the reading with the name of the person who made the check.",
        "",
        "### Shift handover",
        "",
        "Each shift ends with a handover that names what was finished, what is still open and what the next crew must not touch. The handover is written by hand on the slate in the tool room and copied into the ledger before the watch changes. Nothing is left on the slate after the copy, so the ledger is the only record a later reader needs.",
        "",
        "1. Finished: the north pier lamps, the rope count and the dock gate repair.",
        "2. Open: one crate on the south pier, the damp canvas bundle and the cooper's barrels.",
        "3. Do not touch: the fuel drum seal until the inspector has signed the form.",
        "4. Watch: the wind shift expected after the noon reading on the third day.",
        "5. Contacts: the cooper, the inspector and the dock foreman, each with a number on the slate.",
        "",
        "The handover names the crew member who will answer questions in the morning, so that no item waits for a shift that has already gone home. Questions that cannot wait are sent to the foreman, who decides whether the item moves to the day list or stays on the night list.",
        "",
        "### Equipment checks",
        "",
        "Equipment checks run on a fixed rota so that each item is looked at at least once a week. The rota lists the lamps, the winches, the pulleys, the chains, the saw and the scales. Each check records the date, the person and the result. A failed check removes the item from service until a second check passes, and the removal is recorded in the same line as the failure.",
        "",
        "- Lamps: all twelve tested, two globes cracked and replaced from the spare box.",
        "- Winches: the north winch greased, the south winch run under load and held.",
        "- Pulleys: three pulleys spun free, one sheave worn and set aside for the cooper.",
        "- Chains: the gate chain tensioned, the ferry chain links counted and found whole.",
        "- Saw: blade sharpened, guard checked, the bench cleared of shavings.",
        "- Scales: zeroed against the brass weight, the reading matches the sheet within tolerance.",
        "",
        "The equipment checks finish with a short paragraph on what the crew would change next week if the budget allowed. The suggestions stay in the ledger until the foreman reviews them, and none of them takes effect before the review.",
        "",
        "### Cargo and weather",
        "",
        "The cargo manifest for the week lists forty-two crates, eleven barrels and three bundles of canvas. Weather held steady for most of the week, with one squall on the third day that moved two tarps and a loose sign. The crew logged each event with the time and the pier it touched, so the next shift can trace every item back to its origin without reading the full log.",
        "",
        "1. Crates: forty-two counted, forty-one stacked, one held for inspection.",
        "2. Barrels: eleven counted, nine sealed, two waiting on the cooper.",
        "3. Canvas: three bundles counted, one bundle damp, dried in the tool room.",
        "4. Sign: loose sign secured to the gate post with new wire.",
        "",
        "```py",
        "def weekly_total(days):",
        "    crates = [day.get(\"crates\", 0) for day in days]",
        "    barrels = [day.get(\"barrels\", 0) for day in days]",
        "    return sum(crates) + sum(barrels)",
        "",
        "print(weekly_total([{\"crates\": 42, \"barrels\": 11}]))",
        "```",
        "",
        "### Storm week",
        "",
        "The storm that passed through on the fourth day tested every item on the rota. The north pier took most of the spray, and the lamps there were relit by hand after the power line failed for two hours. The crew kept a running count of each thing that was moved, lashed or lost, and the count is copied here so that the insurance form can be filled from one place without a second search.",
        "",
        "- Lashed: forty crates on the south pier, each with two straps and a tag.",
        "- Moved: eleven barrels from the open dock to the inner shed before the rain.",
        "- Lost: one tarp torn beyond repair, one sign blown into the harbor and not recovered.",
        "- Relit: seven lamps on the north pier, all checked against the spare box afterwards.",
        "- Dried: the canvas bundles and the grain sacks, turned twice a day in the tool room.",
        "",
        "After the storm the foreman asked for a plain list of what was still standing. The list was short. Every pier kept its gate, every shed kept its roof, and the ferry dock kept its bollards, although two of them now lean toward the water and will be set again when the tide is low enough to work the footings.",
        "",
        "The repair plan follows the same order as the damage report. Lamps come first because the night watch depends on them, then the gates, then the sheds, and last the cosmetic work on the signs. Each repair is entered as a separate line with its own owner and its own date, so a delay in one item does not hold up the others.",
        "",
        "Recovery work took four days and used the crew from both shifts. Overtime was logged against each person by name, and the hours are kept in the ledger beside the repair they paid for, so the foreman can see what each fix cost without reading the whole week again.",
        "",
        "### Open items",
        "",
        "The open items list stays short on purpose. Each entry has an owner, a pier and a date, and the crew reviews the list at the start of every shift. Items close when the owner signs the margin and the night watch confirms the change in the ledger.",
        "",
        "Closing note: the ledger balances for the week, the open items are assigned, and the next report will start from these same counts.",
    ];
    return sections.join("\n").slice(0, STREAM_LENGTH);
}

function handle(body, response) {
    if (body.stream === false) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
            id: "reply",
            model: body.model,
            choices: [{ index: 0, message: { role: "assistant", content: "Bench" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        }));
        return;
    }
    const messages = body.messages ?? [];
    const lastUser = messages.findLastIndex((message) => message.role === "user");
    const text = textOf(messages[lastUser]).trim();
    const results = messages.slice(lastUser + 1).filter((message) => message.role === "tool").length;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const seed = text.match(/^SEED (\d+)$/);
    if (seed) {
        const n = Number(seed[1]);
        if (n % 3 === 0 && results === 0) {
            respondWithCall(body.model, response, { name: "write", input: { path: `notes/seed-${n}.md`, content: writeContent(n) } });
        } else {
            respondWithText(body.model, response, seedText(n));
        }
        return;
    }
    if (text.startsWith("STREAM")) {
        streamMarkdown(body.model, response);
        return;
    }
    respondWithText(body.model, response, "Ready.");
}

function textOf(message) {
    if (typeof message?.content === "string") return message.content;
    if (Array.isArray(message?.content)) {
        return message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
    }
    return "";
}

function respondWithText(model, response, text) {
    response.write(chunk(model, { role: "assistant", content: text }, "stop"));
    response.end("data: [DONE]\n\n");
}

function respondWithCall(model, response, step) {
    callCount += 1;
    const call = { index: 0, id: `call-${callCount}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.input) } };
    response.write(chunk(model, { role: "assistant", tool_calls: [call] }, "tool_calls"));
    response.end("data: [DONE]\n\n");
}

function streamMarkdown(model, response) {
    const text = streamText();
    const deltas = [];
    for (let at = 0; at < text.length; at += STREAM_DELTA_CHARS) {
        deltas.push(text.slice(at, at + STREAM_DELTA_CHARS));
    }
    let next = 0;
    let timer;
    let step;
    const stop = () => {
        clearTimeout(timer);
        clearInterval(step);
    };
    response.on("close", stop);
    timer = setTimeout(() => {
        step = setInterval(() => {
            if (response.destroyed) {
                stop();
                return;
            }
            if (next < deltas.length) {
                const delta = next === 0 ? { role: "assistant", content: deltas[next] } : { content: deltas[next] };
                response.write(chunk(model, delta, null));
                next += 1;
                return;
            }
            stop();
            response.write(chunk(model, {}, "stop"));
            response.end("data: [DONE]\n\n");
        }, STREAM_STEP_MS);
    }, STREAM_DELAY_MS);
}

function chunk(model, delta, finish) {
    const choice = { index: 0, delta, finish_reason: finish };
    return `data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", model, choices: [choice] })}\n\n`;
}
