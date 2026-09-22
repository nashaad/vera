// Labels are sample text so the sketch reads, not a copy of the real screen. Unlabelled rows draw as bars.
export interface SketchRow {
    label?: string;
    // The part of the label that matches the search, drawn brighter.
    hit?: string;
    active?: boolean;
    favorite?: boolean;
    // An answer typed on the row itself, as Increase budget does.
    input?: string;
}

export interface SketchField {
    label: string;
    focused?: boolean;
    filled?: boolean;
}

export interface SketchDialog {
    title?: string;
    // A line of detail under the title, such as the command an approval is for.
    body?: string;
    // '' shows the Search placeholder.
    search?: string;
    searchFocused?: boolean;
    fields?: SketchField[];
    rows?: SketchRow[];
}

// Mirrors the TUI's single queue line: `queued · <first prompt> · +N`.
export interface SketchQueue {
    phase: 'queued' | 'sending';
    prompt: string;
    more: number;
}

// A page replaces the conversation inside the main box; the composer stays below it.
export interface SketchPage {
    focus: 'left' | 'right';
    activeRow: number;
    openRow: number;
}

// Key caps show on the frame before the step, where the key is pressed. Without an anchor they sit on the
// dialog, the focused pane, or the composer.
export type KeysAnchor = 'composer' | 'dialog' | 'header' | 'patch' | 'tree';

// Each step pairs what the reader does (`action`, pressing `keys`) with what the frame now shows (`result`).
export interface ScreenStep {
    action?: string;
    keys: string[];
    keysAt?: KeysAnchor;
    result?: string;
    composer: string;
    composerFocused: boolean;
    conversation?: ConversationName;
    header?: SketchHeader;
    working?: boolean;
    queue?: SketchQueue;
    dialog?: SketchDialog;
    page?: SketchPage;
    // Key caps drawn on this step's own frame and kept there, for a press the reader should see.
    held?: string[];
    flow?: Omit<FlowHighlight, 'step'>;
    // How many of the sequence's `context` entries the model can see, and how many of those just arrived.
    context?: number;
    fresh?: number;
}

export type ConversationName =
    | 'first' | 'second' | 'steering' | 'steered' | 'sent'
    | 'tool-start' | 'tool-asked' | 'tool-read' | 'tool-edit' | 'tool-running' | 'tool-ran' | 'tool-done'
    | 'budget-start' | 'budget-set' | 'budget-half' | 'budget-eighty' | 'budget-continued'
    | 'rules-start' | 'rules-asked' | 'rules-read' | 'rules-done' | 'rules-without'
    | 'fill-ledger' | 'fill-log-ask' | 'fill-log' | 'fill-rum' | 'fill-course' | 'fill-map' | 'fill-failed' | 'fill-summarized' | 'fill-answered'
    | 'nudge-ask' | 'nudge-read' | 'nudge-answer' | 'nudge-parrot' | 'nudge-parrot-done' | 'nudge-sail' | 'nudge-done';

// Parts of the How Vera works diagram. A step with `flow` lights them while it shows.
export type FlowNode = 'message' | 'model' | 'response' | 'request' | 'permission' | 'run' | 'results';
export type FlowLine = 'message-model' | 'model-response' | 'model-request' | 'request-permission' | 'permission-run' | 'run-results' | 'results-model';

export const FLOW_EVENT = 'vera-flow';

// `node` is where the step lands and gets the step number; `trail` is the way it came, drawn dimmer.
export interface FlowHighlight {
    step: number;
    node: FlowNode;
    trail: FlowLine[];
    // A short note drawn inside the landing box, such as what the model asked for.
    detail?: string;
    // What the model last decided, kept on its box while the loop runs elsewhere.
    model?: string;
    // How many CONTEXT_ENTRIES the model can see at this step.
    context?: number;
}

export type ContextRole = 'system' | 'you' | 'model' | 'tool' | 'rule' | 'nudge' | 'summary' | 'more' | 'cut';

export interface ContextEntry {
    role: ContextRole;
    text: string;
    // Roughly how much room it takes, in lines; a file read is the big one.
    lines?: number;
    // Compaction removes rows, so a sequence that shows it gives every entry the step it arrives at and leaves at.
    at?: number;
    gone?: number;
    // The step it is shown struck through, just before it leaves.
    folding?: number;
    // The row the reader should watch, drawn blue and blinking.
    key?: boolean;
    // Approximate size; when a sequence gives these, its meter sums them.
    tokens?: number;
    // It arrived but does not fit in the window.
    overflow?: boolean;
}

// What the model sees during the tool-call walkthrough, in the order it arrives.
export const CONTEXT_ENTRIES: ContextEntry[] = [
    { role: 'system', text: 'instructions, tools, project rules', lines: 2 },
    { role: 'you', text: 'mark the X in src/map.ts and run the tests' },
    { role: 'model', text: 'asks to read src/map.ts' },
    { role: 'tool', text: 'src/map.ts, 42 lines of code', lines: 3 },
    { role: 'model', text: 'asks to edit src/map.ts' },
    { role: 'tool', text: 'edited src/map.ts' },
    { role: 'model', text: 'asks to run bun test' },
    { role: 'tool', text: '12 pass, 0 fail' },
    { role: 'model', text: 'Marked the X at the north cove. The map tests pass.' },
];

// A scoped rule is a hidden message after the tool result, so only this panel shows it arriving.
const RULE_SHARED: ContextEntry[] = [
    { role: 'system', text: 'instructions, tools, always-on rules', lines: 2 },
    { role: 'you', text: 'stash the gold in the chest' },
    { role: 'model', text: 'asks to read treasure/chest.yaml' },
    { role: 'tool', text: 'treasure/chest.yaml, 30 lines', lines: 2 },
];

const RULE_CONTEXT: ContextEntry[] = [
    ...RULE_SHARED,
    { role: 'rule', text: 'chest.yaml is in treasure/, so: every chest gets a decoy lid' },
    { role: 'model', text: 'asks to edit chest.yaml: + decoy lid, gold underneath' },
    { role: 'tool', text: 'edited treasure/chest.yaml' },
    { role: 'model', text: 'Stashed the gold under a decoy lid of three shiny buttons.' },
];

const NO_RULE_CONTEXT: ContextEntry[] = [
    ...RULE_SHARED,
    { role: 'model', text: 'asks to edit chest.yaml: + gold, right on top' },
    { role: 'tool', text: 'edited treasure/chest.yaml' },
    { role: 'model', text: 'Stashed the gold in the chest.' },
];

// Sizes are in made-up crow words, 100 to a window, so the sums stay easy. The trim and summary points follow Vera's defaults.
// Each step adds or changes one thing, so `at` doubles as the step number.
const SYSTEM: ContextEntry = { role: 'system', text: 'instructions, tools, rules', tokens: 10, at: 1 };
const LEDGER_ASK: ContextEntry = { role: 'you', text: 'tally the loot in treasure/ledger.yaml', tokens: 1, at: 1 };
const LEDGER: ContextEntry = { role: 'tool', text: 'all of treasure/ledger.yaml', tokens: 30, at: 1 };
const MORE_14: ContextEntry = { role: 'more', text: '· · ·  14 more messages', tokens: 15, at: 2 };
const LOG_ASK: ContextEntry = { role: 'you', text: "read the ship's log", tokens: 1, at: 3 };
const LOG: ContextEntry = { role: 'tool', text: 'all of ship/log.md', tokens: 20, at: 4 };
const MORE_20: ContextEntry = { role: 'more', text: '· · ·  20 more messages', tokens: 15 };
const RUM: ContextEntry = { role: 'you', text: 'stow the rum below deck', tokens: 1 };
const COURSE: ContextEntry = { role: 'you', text: 'plot a course to skull island', tokens: 1 };
const MAP: ContextEntry = { role: 'tool', text: 'all of maps/skull-island.md', tokens: 20 };

const NO_COMPACTION_CONTEXT: ContextEntry[] = [
    SYSTEM,
    LEDGER_ASK,
    LEDGER,
    MORE_14,
    LOG_ASK,
    LOG,
    { ...MORE_20, at: 5 },
    { ...RUM, at: 6 },
    { ...COURSE, at: 7 },
    { ...MAP, at: 8, overflow: true },
];

const TRIM_AT = 5;
const FOLD_AT = 11;

function folded(entry: ContextEntry): ContextEntry {
    return { ...entry, folding: FOLD_AT, gone: FOLD_AT + 1 };
}

// Everything from the first message up to the last two of yours goes into the summary.
const SUMMARIZED_ROWS: ContextEntry[] = [
    LEDGER_ASK,
    { ...LEDGER, folding: TRIM_AT, gone: TRIM_AT + 1 },
    { role: 'tool', text: 'ledger.yaml trimmed, full copy saved', tokens: 1, at: TRIM_AT + 1, key: true },
    MORE_14,
    LOG_ASK,
    LOG,
    { ...MORE_20, at: 7 },
];

const COMPACTION_CONTEXT: ContextEntry[] = [
    SYSTEM,
    { role: 'cut', text: '✂  summary starts here', at: FOLD_AT, gone: FOLD_AT + 1 },
    { role: 'summary', text: 'raid so far, files: ledger, log', tokens: 5, at: FOLD_AT + 1, key: true },
    // The full ledger already left when its trimmed note replaced it.
    ...SUMMARIZED_ROWS.map((entry) => entry.gone === TRIM_AT + 1 ? entry : folded(entry)),
    { role: 'cut', text: '✂  summary ends here, the rest stays', at: FOLD_AT, gone: FOLD_AT + 1 },
    { ...RUM, at: 8 },
    { ...COURSE, at: 9 },
    { ...MAP, at: 10 },
    { role: 'model', text: 'Course set: two days west, mind the kraken.', tokens: 1, at: 13 },
];

// A nudge set to every 2 turns. Each step adds one row, so `at` doubles as the step number.
const NUDGE: ContextEntry = { role: 'nudge', text: 'end every answer with "arr"' };
const FROM_CACHE = '↑  same as the last request, read from cache';

const NUDGE_CONTEXT: ContextEntry[] = [
    { role: 'system', text: 'instructions, tools, rules', at: 1 },
    { role: 'you', text: 'count the doubloons in treasure/chest.yaml', at: 1 },
    { ...NUDGE, at: 2 },
    { role: 'model', text: 'asks to read treasure/chest.yaml', at: 3 },
    { role: 'tool', text: 'treasure/chest.yaml: 40 doubloons', at: 4 },
    { role: 'model', text: '40 doubloons in the chest, arr.', at: 5 },
    { role: 'cut', text: FROM_CACHE, at: 7, gone: 9 },
    { role: 'you', text: 'hide them from the parrot', at: 6 },
    { role: 'model', text: "Buried under the crow's nest.", at: 8 },
    { role: 'cut', text: FROM_CACHE, at: 11 },
    { role: 'you', text: 'sail for skull island', at: 9 },
    { ...NUDGE, at: 10 },
    { role: 'model', text: 'Heading west, arr.', at: 12 },
];

export interface SketchHeader {
    name: string;
    status?: string;
}

export interface ScreenSteps {
    title: string;
    steps: ScreenStep[];
    // Drawn as What the model sees above the screen.
    context?: ContextEntry[];
    // Drawn above the context; each lights up from the step it arrives at.
    ruleFiles?: RuleFile[];
    // A tag beside the title, for sequences shown as a pair.
    verdict?: Verdict;
    // A token meter under the context; `marks` are percents where Vera acts.
    meter?: ContextMeter;
}

export interface ContextMeter {
    window: number;
    marks: MeterMark[];
}

export interface MeterMark {
    percent: number;
    label: string;
}

export interface Verdict {
    tone: 'bad' | 'good';
    text: string;
}

export interface RuleFile {
    file: string;
    folder: string;
    text: string;
    step: number;
}

export type ScreenStepsName =
    | 'command-palette'
    | 'switch-model'
    | 'resume-conversation'
    | 'keep-running'
    | 'add-provider'
    | 'queued-messages'
    | 'workspace-diff'
    | 'tool-call'
    | 'budget-limit'
    | 'rule-without'
    | 'scoped-rule'
    | 'context-no-compaction'
    | 'context-compaction'
    | 'standing-nudge';

const APPROVAL: SketchRow[] = [
    { label: 'Allow once', active: true },
    { label: 'Session' },
    { label: 'Deny' },
    { label: 'Always' },
];

const BUDGET_TITLE = 'Budget exceeded: $3.04 / $3.00.';
const BUDGET_BODY = 'Continue spending? Enter a new total above $3.04.';
const BUDGET_CHOICES: SketchRow[] = [
    { label: '1. Stop', active: true },
    { label: '2. Ignore budget and continue' },
    { label: '3. Increase budget and continue' },
];

function increase(input: string): SketchDialog {
    return {
        title: BUDGET_TITLE,
        body: BUDGET_BODY,
        rows: [{ label: '1. Stop' }, BUDGET_CHOICES[1], { label: '3. Increase budget and continue:', active: true, input }],
    };
}

export const DIFF_FILES = ['src/map.ts', 'src/treasure.ts', 'test/map.test.ts', 'README.md'];

function active<T extends { active?: boolean }>(rows: T[], at: number): T[] {
    return rows.map((row, index) => ({ ...row, active: index === at }));
}

const COMMANDS: SketchRow[] = [
    { label: 'Switch model' },
    { label: 'Switch conversation' },
    { label: 'Open settings' },
    { label: 'Search past work' },
    { label: 'Show work' },
];

const COMMANDS_TYPED: SketchRow[] = [
    { label: 'Switch model', hit: 'Sw' },
    { label: 'Switch conversation', hit: 'Sw' },
    { label: 'Switch agents', hit: 'Sw' },
];

const MODELS: SketchRow[] = [
    { label: 'model-large', favorite: true },
    { label: 'model-fast' },
    { label: 'model-mini' },
    { label: 'local-model' },
    { label: 'model-vision' },
];

const MODELS_TYPED: SketchRow[] = [
    { label: 'model-large', hit: 'large' },
    { label: 'model-large-preview', hit: 'large' },
    { label: 'jollyroger/model-large', hit: 'large' },
];

const EFFORT_ROWS: SketchRow[] = [{ label: 'low' }, { label: 'medium' }, { label: 'high' }];

const CONVERSATIONS: SketchRow[] = [
    { label: 'A · Chart the route to the island' },
    { label: 'B · Count the shiny coins' },
    { label: 'Patch the crow\'s nest' },
    { label: 'Teach the parrot to sort' },
    { label: 'Bury the spare buttons' },
];

const LEAVE: SketchRow[] = [{ label: 'Stop & switch' }, { label: 'Switch, keep running' }];

const PROVIDERS: SketchRow[] = [{ label: 'OpenRouter · API key' }, { label: 'Add provider' }];

function picker(at: number): SketchDialog {
    return { title: 'Switch conversation', search: '', searchFocused: true, rows: active(CONVERSATIONS, at) };
}

function models(at: number): SketchDialog {
    return { title: 'Switch model', search: '', searchFocused: true, rows: active(MODELS, at) };
}

function modelsTyped(at: number): SketchDialog {
    return { title: 'Switch model', search: 'large', searchFocused: true, rows: active(MODELS_TYPED, at) };
}

const EFFORT: SketchDialog = { title: 'Reasoning effort', rows: active(EFFORT_ROWS, 1) };

export const screenSteps: Record<ScreenStepsName, ScreenSteps> = {
    'command-palette': {
        title: 'Run a command from the palette',
        steps: [
            { action: 'Start in the composer.', keys: [], composer: '', composerFocused: true },
            {
                action: 'Or enter `/palette`.',
                keys: ['Ctrl+P'],
                result: 'Commands opens over the conversation with Search focused.',
                composer: '',
                composerFocused: false,
                dialog: { title: 'Commands', search: '', searchFocused: true, rows: active(COMMANDS, 0) },
            },
            {
                action: 'Type part of a command name.',
                keys: [],
                result: 'The list narrows to matching commands.',
                composer: '',
                composerFocused: false,
                dialog: { title: 'Commands', search: 'Sw', searchFocused: true, rows: active(COMMANDS_TYPED, 0) },
            },
            {
                keys: ['Down'],
                result: 'The highlight moves to the next match.',
                composer: '',
                composerFocused: false,
                dialog: { title: 'Commands', search: 'Sw', searchFocused: true, rows: active(COMMANDS_TYPED, 1) },
            },
            {
                keys: ['Enter'],
                result: 'The highlighted command runs and opens its screen. Escape returns to the composer.',
                composer: '',
                composerFocused: false,
                dialog: picker(0),
            },
        ],
    },
    'switch-model': {
        title: 'Switch the model for this conversation',
        steps: [
            { action: 'Type `/model` in the composer.', keys: [], composer: '/model', composerFocused: true },
            {
                keys: ['Enter'],
                result: 'Switch model opens. Favorites come first, then recent models, then every connected model.',
                composer: '',
                composerFocused: false,
                dialog: models(0),
            },
            {
                action: 'Type part of a model name.',
                keys: [],
                result: 'The list narrows. Search covers every connected model, not only favorites.',
                composer: '',
                composerFocused: false,
                dialog: modelsTyped(0),
            },
            {
                keys: ['Down'],
                result: 'The highlight moves to the next match.',
                composer: '',
                composerFocused: false,
                dialog: modelsTyped(1),
            },
            {
                keys: ['Enter'],
                result: 'If the model offers effort levels, Vera asks for one.',
                composer: '',
                composerFocused: false,
                dialog: EFFORT,
            },
            {
                action: 'Choose an effort level.',
                keys: ['Enter'],
                result: 'Back in the composer. The next request uses the new model.',
                composer: '',
                composerFocused: true,
            },
        ],
    },
    'resume-conversation': {
        title: 'Resume another conversation',
        steps: [
            {
                action: 'Type `/resume`. Ctrl+E does the same.',
                keys: [],
                composer: '/resume',
                composerFocused: true,
                header: { name: 'A' },
            },
            {
                keys: ['Enter'],
                result: 'The picker lists your conversations.',
                composer: '',
                composerFocused: false,
                header: { name: 'A' },
                dialog: picker(0),
            },
            {
                action: 'Choose a conversation.',
                keys: ['Down'],
                result: 'The highlight moves to the next one.',
                composer: '',
                composerFocused: false,
                header: { name: 'A' },
                dialog: picker(1),
            },
            {
                keys: ['Enter'],
                result: 'B opens in place of A.',
                composer: '',
                composerFocused: true,
                header: { name: 'B' },
                conversation: 'second',
            },
        ],
    },
    'keep-running': {
        title: 'Leave a conversation running and switch',
        steps: [
            {
                action: 'While A is working, type `/resume`.',
                keys: [],
                composer: '/resume',
                composerFocused: true,
                header: { name: 'A', status: 'working' },
                working: true,
            },
            {
                keys: ['Enter'],
                result: 'The picker lists your conversations.',
                composer: '',
                composerFocused: false,
                header: { name: 'A', status: 'working' },
                working: true,
                dialog: picker(0),
            },
            {
                action: 'Choose conversation B.',
                keys: ['Down'],
                result: 'The highlight moves to B.',
                composer: '',
                composerFocused: false,
                header: { name: 'A', status: 'working' },
                working: true,
                dialog: picker(1),
            },
            {
                keys: ['Enter'],
                result: 'A is still working, so Vera asks what happens to it.',
                composer: '',
                composerFocused: false,
                header: { name: 'A', status: 'working' },
                working: true,
                dialog: { title: 'Leave A?', rows: active(LEAVE, 0) },
            },
            {
                action: 'To keep A running, choose Switch, keep running.',
                keys: ['Down'],
                composer: '',
                composerFocused: false,
                header: { name: 'A', status: 'working' },
                working: true,
                dialog: { title: 'Leave A?', rows: active(LEAVE, 1) },
            },
            {
                keys: ['Enter'],
                result: 'B opens. A keeps working in the background.',
                composer: '',
                composerFocused: true,
                header: { name: 'B' },
                conversation: 'second',
            },
            {
                keys: ['Ctrl+Shift+Left'],
                keysAt: 'header',
                result: 'Back in A, still working, without opening the picker.',
                composer: '',
                composerFocused: true,
                header: { name: 'A', status: 'working' },
                working: true,
            },
            {
                keys: ['Ctrl+Shift+Right'],
                keysAt: 'header',
                result: 'And over to B again. These keys cycle through every live conversation.',
                composer: '',
                composerFocused: true,
                header: { name: 'B' },
                conversation: 'second',
            },
        ],
    },
    'add-provider': {
        title: 'Connect a provider, then use one of its models',
        steps: [
            {
                action: 'Open the palette and choose Configure providers.',
                keys: ['Ctrl+P'],
                result: 'Your connections are listed, with Add provider at the end.',
                composer: '',
                composerFocused: false,
                dialog: { title: 'Configure providers', rows: active(PROVIDERS, 0) },
            },
            {
                keys: ['Down'],
                result: 'Add provider is highlighted.',
                composer: '',
                composerFocused: false,
                dialog: { title: 'Configure providers', rows: active(PROVIDERS, 1) },
            },
            {
                keys: ['Enter'],
                result: 'The Add provider form opens. Known providers prefill the endpoint.',
                composer: '',
                composerFocused: false,
                dialog: {
                    title: 'Add provider',
                    fields: [{ label: 'Name', focused: true }, { label: 'Endpoint' }, { label: 'API key' }],
                },
            },
            {
                action: 'Fill in the form, then save.',
                keys: ['Enter'],
                result: 'Vera reads the catalog and reports how many models it found.',
                composer: '',
                composerFocused: false,
                dialog: {
                    title: 'Configure providers',
                    rows: [{ label: 'OpenRouter · API key' }, { label: 'Jolly Roger · 42 models', active: true }, { label: 'Add provider' }],
                },
            },
            {
                action: 'Close it, then enter `/model`.',
                keys: ['Escape'],
                result: 'Switch model opens.',
                composer: '',
                composerFocused: false,
                dialog: models(0),
            },
            {
                action: 'Type part of a model name.',
                keys: [],
                result: 'Search includes the new provider\'s models.',
                composer: '',
                composerFocused: false,
                dialog: modelsTyped(0),
            },
            {
                keys: ['Down', 'Down'],
                result: 'The new provider\'s model is highlighted.',
                composer: '',
                composerFocused: false,
                dialog: modelsTyped(2),
            },
            {
                action: 'Optional.',
                keys: ['Ctrl+F'],
                result: 'The highlighted model is now a favorite (★). Favorites list first next time.',
                composer: '',
                composerFocused: false,
                dialog: {
                    ...modelsTyped(2),
                    rows: active(MODELS_TYPED, 2).map((row, index) => (index === 2 ? { ...row, favorite: true } : row)),
                },
            },
            {
                keys: ['Enter'],
                result: 'If the model offers effort levels, Vera asks for one.',
                composer: '',
                composerFocused: false,
                dialog: EFFORT,
            },
            {
                action: 'Choose an effort level.',
                keys: ['Enter'],
                result: 'Back in the composer. The next request uses the new model.',
                composer: '',
                composerFocused: true,
            },
        ],
    },
    'queued-messages': {
        title: 'Queue follow-ups while Vera works',
        steps: [
            {
                action: 'While Vera works, type a follow-up.',
                keys: [],
                result: 'The turn keeps running.',
                composer: 'also mark the X',
                composerFocused: true,
                working: true,
            },
            {
                keys: ['Enter'],
                result: 'The prompt is queued, not sent. The line above the composer shows it.',
                composer: '',
                composerFocused: true,
                working: true,
                queue: { phase: 'queued', prompt: 'also mark the X', more: 0 },
            },
            {
                action: 'With the composer empty.',
                keys: ['Escape'],
                result: 'Vera stops the turn and sends the oldest queued prompt. The answer picks up from there.',
                composer: '',
                composerFocused: true,
                working: true,
                conversation: 'steering',
            },
            {
                action: 'To send several at once, queue another follow-up.',
                keys: [],
                composer: 'then hide the map',
                composerFocused: true,
                working: true,
                conversation: 'steered',
            },
            {
                keys: ['Enter'],
                result: 'It waits in the queue.',
                composer: '',
                composerFocused: true,
                working: true,
                conversation: 'steered',
                queue: { phase: 'queued', prompt: 'then hide the map', more: 0 },
            },
            {
                action: 'And one more.',
                keys: [],
                composer: 'and feed the parrot',
                composerFocused: true,
                working: true,
                conversation: 'steered',
                queue: { phase: 'queued', prompt: 'then hide the map', more: 0 },
            },
            {
                keys: ['Enter'],
                result: '`+1` means one more is waiting. Queued prompts wait for you, even after the turn ends.',
                composer: '',
                composerFocused: true,
                working: true,
                conversation: 'steered',
                queue: { phase: 'queued', prompt: 'then hide the map', more: 1 },
            },
            {
                action: 'With the composer empty.',
                keys: ['Enter'],
                result: 'Vera stops the turn and sends the whole queue.',
                composer: '',
                composerFocused: true,
                working: true,
                conversation: 'steered',
                queue: { phase: 'sending', prompt: 'then hide the map', more: 1 },
            },
            {
                keys: [],
                result: 'Both prompts arrive as separate messages, and Vera answers them together.',
                composer: '',
                composerFocused: true,
                working: true,
                conversation: 'sent',
            },
        ],
    },
    'workspace-diff': {
        title: 'Browse workspace changes',
        steps: [
            { action: 'Type `/diff` in the composer.', keys: [], composer: '/diff', composerFocused: true },
            {
                keys: ['Enter'],
                result: 'Patches on the left, the file tree on the right.',
                composer: '',
                composerFocused: false,
                page: { focus: 'right', activeRow: 0, openRow: 0 },
            },
            {
                action: 'Choose a file in the tree.',
                keys: ['Down'],
                result: 'The highlight moves down the tree.',
                composer: '',
                composerFocused: false,
                page: { focus: 'right', activeRow: 1, openRow: 0 },
            },
            {
                keys: ['Enter'],
                result: 'Its patch opens on the left.',
                composer: '',
                composerFocused: false,
                page: { focus: 'right', activeRow: 1, openRow: 1 },
            },
            {
                keys: ['Tab'],
                result: 'Focus moves to the patch. PageUp and PageDown scroll it.',
                composer: '',
                composerFocused: false,
                page: { focus: 'left', activeRow: 1, openRow: 1 },
            },
            {
                action: 'Or Q.',
                keys: ['Escape'],
                result: 'Back in the conversation.',
                composer: '',
                composerFocused: true,
            },
        ],
    },
    'tool-call': {
        title: 'One request, three tool calls',
        steps: [
            {
                action: 'Ask for a change.',
                keys: [],
                composer: 'mark the X in src/map.ts and run the tests',
                composerFocused: true,
                conversation: 'tool-start',
                flow: { node: 'message', trail: [], detail: 'mark the X…', context: 1 },
            },
            {
                keys: ['Enter'],
                result: 'The model reads your message and asks to read `src/map.ts`.',
                composer: '',
                composerFocused: true,
                conversation: 'tool-asked',
                working: true,
                flow: { node: 'request', trail: ['message-model', 'model-request'], detail: 'read src/map.ts', model: 'needs the file', context: 3 },
            },
            {
                result: 'Reading is allowed in ask mode, so Vera runs the tool. The file contents go back to the model.',
                keys: [],
                composer: '',
                composerFocused: true,
                conversation: 'tool-read',
                working: true,
                flow: { node: 'results', trail: ['request-permission', 'permission-run', 'run-results'], detail: 'the file, 42 lines', model: 'needs the file', context: 4 },
            },
            {
                result: 'It asks to edit the file. Edits inside the workspace are allowed too, so the loop runs again without stopping.',
                keys: [],
                composer: '',
                composerFocused: true,
                conversation: 'tool-edit',
                working: true,
                flow: { node: 'run', trail: ['results-model', 'model-request', 'request-permission', 'permission-run'], detail: 'edit src/map.ts', model: 'mark the X', context: 5 },
            },
            {
                result: 'Next it asks to run a command. No rule allows that in ask mode, so Vera asks you first.',
                keys: [],
                composer: '',
                composerFocused: false,
                conversation: 'tool-edit',
                working: true,
                dialog: {
                    title: 'Permission required · bash',
                    body: 'bun test',
                    rows: APPROVAL,
                },
                flow: { node: 'permission', trail: ['run-results', 'results-model', 'model-request', 'request-permission'], detail: 'bash? ask you', model: 'run the tests', context: 7 },
            },
            {
                action: 'Press 1 to allow it once.',
                keys: [],
                held: ['1'],
                composer: '',
                composerFocused: false,
                conversation: 'tool-edit',
                working: true,
                dialog: {
                    title: 'Permission required · bash',
                    body: 'bun test',
                    rows: APPROVAL,
                },
                flow: { node: 'permission', trail: [], detail: 'you: allow once', model: 'run the tests', context: 7 },
            },
            {
                keys: [],
                result: 'Vera runs `bun test`. The group header says Running until it finishes.',
                composer: '',
                composerFocused: true,
                conversation: 'tool-running',
                working: true,
                flow: { node: 'run', trail: ['permission-run'], detail: 'bun test', model: 'run the tests', context: 7 },
            },
            {
                keys: [],
                result: 'The tests pass. The first line of output shows here, and the whole output goes back to the model.',
                composer: '',
                composerFocused: true,
                conversation: 'tool-ran',
                working: true,
                flow: { node: 'results', trail: ['run-results'], detail: '12 pass, 0 fail', model: 'run the tests', context: 8 },
            },
            {
                result: 'The model needs nothing else, so it answers.',
                keys: [],
                composer: '',
                composerFocused: true,
                conversation: 'tool-done',
                flow: { node: 'response', trail: ['results-model', 'model-response'], detail: 'Marked the X…', model: 'done, answer', context: 9 },
            },
        ],
    },
    'budget-limit': {
        title: 'Set a budget and decide at the limit',
        steps: [
            { action: 'Type `/budget 3`.', keys: [], composer: '/budget 3', composerFocused: true, conversation: 'budget-start' },
            {
                keys: ['Enter'],
                result: 'The budget counts the whole conversation, including work already done.',
                composer: '',
                composerFocused: true,
                conversation: 'budget-set',
            },
            { action: 'Ask for more work.', keys: [], composer: 'raid the kraken\'s reef for shiny buttons', composerFocused: true, conversation: 'budget-set' },
            {
                keys: ['Enter'],
                result: 'Past half, the next request starts with a notice. The model gets the same line.',
                composer: '',
                composerFocused: true,
                conversation: 'budget-half',
                working: true,
            },
            {
                keys: [],
                result: 'At 80% there is one more.',
                composer: '',
                composerFocused: true,
                conversation: 'budget-eighty',
                working: true,
            },
            {
                keys: [],
                result: 'At the budget, work pauses before the next request. Stop is selected.',
                composer: '',
                composerFocused: false,
                conversation: 'budget-eighty',
                working: true,
                dialog: { title: BUDGET_TITLE, body: BUDGET_BODY, rows: BUDGET_CHOICES },
            },
            {
                keys: ['3'],
                result: 'Increase asks for the new total on the row itself.',
                composer: '',
                composerFocused: false,
                conversation: 'budget-eighty',
                working: true,
                dialog: increase(''),
            },
            {
                action: 'Type the new total.',
                keys: [],
                composer: '',
                composerFocused: false,
                conversation: 'budget-eighty',
                working: true,
                dialog: increase('5'),
            },
            {
                keys: ['Enter'],
                result: 'Work continues. The model is told you raised the budget.',
                composer: '',
                composerFocused: true,
                conversation: 'budget-continued',
                working: true,
            },
        ],
    },
    'rule-without': {
        title: 'Without a rule',
        verdict: { tone: 'bad', text: 'Raiders win: no rule arrived' },
        context: NO_RULE_CONTEXT,
        ruleFiles: [],
        steps: [
            {
                action: 'Ask to stash the gold.',
                keys: [],
                result: 'This project has no rule files.',
                composer: 'stash the gold in the chest',
                composerFocused: true,
                conversation: 'rules-start',
                context: 1,
            },
            {
                keys: ['Enter'],
                result: 'The model asks to read the chest.',
                composer: '',
                composerFocused: true,
                conversation: 'rules-asked',
                working: true,
                context: 3,
                fresh: 2,
            },
            {
                keys: [],
                result: 'The file comes back. No rule covers `treasure/`, so nothing else arrives.',
                composer: '',
                composerFocused: true,
                conversation: 'rules-read',
                working: true,
                context: 4,
                fresh: 1,
            },
            {
                keys: [],
                result: 'The model does the plain thing: the gold goes straight in the chest, right on top where raiders look first.',
                composer: '',
                composerFocused: true,
                conversation: 'rules-without',
                context: 7,
                fresh: 3,
            },
        ],
    },
    'scoped-rule': {
        title: 'With a rule for treasure/',
        verdict: { tone: 'good', text: 'Gold stays hidden: the rule arrived' },
        context: RULE_CONTEXT,
        ruleFiles: [
            { file: 'treasure.md', folder: 'treasure/', text: 'every chest gets a decoy lid', step: 3 },
        ],
        steps: [
            {
                action: 'Ask to stash the gold.',
                keys: [],
                result: 'Files in `treasure/` have a rule: every chest gets a decoy lid. It is not in the context yet.',
                composer: 'stash the gold in the chest',
                composerFocused: true,
                conversation: 'rules-start',
                context: 1,
            },
            {
                keys: ['Enter'],
                result: 'The model asks to read the chest.',
                composer: '',
                composerFocused: true,
                conversation: 'rules-asked',
                working: true,
                context: 3,
                fresh: 2,
            },
            {
                keys: [],
                result: 'The file comes back. It is in `treasure/`, so the rule comes with it.',
                composer: '',
                composerFocused: true,
                conversation: 'rules-read',
                working: true,
                context: 5,
                fresh: 2,
            },
            {
                keys: [],
                result: 'The model follows the rule: a decoy lid of three shiny buttons, with the gold underneath.',
                composer: '',
                composerFocused: true,
                conversation: 'rules-done',
                context: 8,
                fresh: 3,
            },
        ],
    },
    'context-no-compaction': {
        title: 'Without compaction',
        context: NO_COMPACTION_CONTEXT,
        meter: { window: 100, marks: [] },
        steps: [
            {
                action: 'Start a raid.',
                keys: [],
                result: 'Every message takes up room. Reading a file puts all of it in, so the ledger alone is 30 crow words.',
                composer: '',
                composerFocused: true,
                conversation: 'fill-ledger',
            },
            {
                keys: [],
                result: '14 more messages go back and forth. 15 crow words.',
                composer: '',
                composerFocused: true,
                conversation: 'fill-ledger',
            },
            {
                keys: [],
                result: "You ask for the ship's log. 1 crow word.",
                composer: '',
                composerFocused: true,
                conversation: 'fill-log-ask',
            },
            {
                keys: [],
                result: 'The whole log goes in. 20 crow words, 77 in all.',
                composer: '',
                composerFocused: true,
                conversation: 'fill-log',
            },
            {
                keys: [],
                result: '20 more messages. Nothing ever leaves.',
                composer: '',
                composerFocused: true,
                conversation: 'fill-log',
            },
            {
                keys: [],
                result: 'Another message from you.',
                composer: '',
                composerFocused: true,
                conversation: 'fill-rum',
            },
            {
                keys: [],
                result: 'And another. Only 6 crow words of room are left.',
                composer: '',
                composerFocused: true,
                conversation: 'fill-course',
            },
            {
                keys: [],
                result: 'The map is 20 crow words. It does not fit, so the next model call fails.',
                composer: '',
                composerFocused: true,
                conversation: 'fill-failed',
            },
        ],
    },
    'context-compaction': {
        title: "With Vera's compaction",
        context: COMPACTION_CONTEXT,
        meter: { window: 100, marks: [{ percent: 60, label: 'trim' }, { percent: 82, label: 'summarize' }] },
        steps: [
            {
                action: 'Same raid.',
                keys: [],
                result: 'Every message takes up room. Reading a file puts all of it in, so the ledger alone is 30 crow words.',
                composer: '',
                composerFocused: true,
                conversation: 'fill-ledger',
            },
            {
                keys: [],
                result: '14 more messages go back and forth. 15 crow words.',
                composer: '',
                composerFocused: true,
                conversation: 'fill-ledger',
            },
            {
                keys: [],
                result: "You ask for the ship's log. 1 crow word.",
                composer: '',
                composerFocused: true,
                conversation: 'fill-log-ask',
            },
            {
                keys: [],
                result: 'The whole log goes in. 77 crow words, past the 60% line.',
                composer: '',
                composerFocused: true,
                conversation: 'fill-log',
            },
            {
                keys: [],
                result: 'The ledger was read many messages ago, so Vera picks it to trim.',
                composer: '',
                composerFocused: true,
                conversation: 'fill-log',
            },
            {
                keys: [],
                result: 'The ledger shrinks from 30 crow words to a 1-word note, in blue. It says where the full copy is saved. Down to 48.',
                composer: '',
                composerFocused: true,
                conversation: 'fill-log',
            },
            {
                keys: [],
                result: '20 more messages. 63 crow words.',
                composer: '',
                composerFocused: true,
                conversation: 'fill-log',
            },
            {
                keys: [],
                result: 'Another message from you.',
                composer: '',
                composerFocused: true,
                conversation: 'fill-rum',
            },
            {
                keys: [],
                result: 'And another.',
                composer: '',
                composerFocused: true,
                conversation: 'fill-course',
            },
            {
                keys: [],
                result: 'The map goes in. 85 crow words, past the 82% line.',
                composer: '',
                composerFocused: true,
                conversation: 'fill-map',
            },
            {
                keys: [],
                result: 'Vera marks everything between the blue lines for one summary, in one go. Your last two messages and the map stay.',
                composer: '',
                composerFocused: true,
                conversation: 'fill-map',
                working: true,
            },
            {
                keys: [],
                result: 'One 5-word summary, in blue, replaces them. Down to 37.',
                composer: '',
                composerFocused: true,
                conversation: 'fill-summarized',
                working: true,
            },
            {
                keys: [],
                result: 'The next model call fits, and the raid goes on.',
                composer: '',
                composerFocused: true,
                conversation: 'fill-answered',
            },
        ],
    },
    'standing-nudge': {
        title: 'A nudge every 2 turns',
        context: NUDGE_CONTEXT,
        steps: [
            {
                action: 'You ask the crow to count the loot.',
                keys: [],
                result: "Vera's instructions and tools go first, then your message.",
                composer: '',
                composerFocused: true,
                conversation: 'nudge-ask',
            },
            {
                keys: [],
                result: 'Your nudge matches, so Vera adds it right after your message. The transcript does not show it.',
                composer: '',
                composerFocused: true,
                conversation: 'nudge-ask',
                working: true,
            },
            {
                keys: [],
                result: 'The model asks to read the chest.',
                composer: '',
                composerFocused: true,
                conversation: 'nudge-ask',
                working: true,
            },
            {
                keys: [],
                result: 'The chest goes in.',
                composer: '',
                composerFocused: true,
                conversation: 'nudge-read',
                working: true,
            },
            {
                keys: [],
                result: 'The answer ends with arr, as the nudge asked.',
                composer: '',
                composerFocused: true,
                conversation: 'nudge-answer',
            },
            {
                action: 'Turn 2.',
                keys: [],
                result: 'The nudge runs every 2 turns, so this turn gets none.',
                composer: '',
                composerFocused: true,
                conversation: 'nudge-parrot',
            },
            {
                keys: [],
                result: 'Everything above the line is sent exactly as last time, so the provider reads it from its cache.',
                composer: '',
                composerFocused: true,
                conversation: 'nudge-parrot',
                working: true,
            },
            {
                keys: [],
                result: 'Only the new message is read fresh.',
                composer: '',
                composerFocused: true,
                conversation: 'nudge-parrot-done',
            },
            {
                action: 'Turn 3.',
                keys: [],
                result: 'You send the next order.',
                composer: '',
                composerFocused: true,
                conversation: 'nudge-sail',
            },
            {
                keys: [],
                result: 'The nudge is due again. Vera adds it after this message, and the first one stays where it was.',
                composer: '',
                composerFocused: true,
                conversation: 'nudge-sail',
                working: true,
            },
            {
                keys: [],
                result: 'Nothing above moved, so the cache still covers all of it.',
                composer: '',
                composerFocused: true,
                conversation: 'nudge-sail',
                working: true,
            },
            {
                keys: [],
                result: 'The answer ends with arr again.',
                composer: '',
                composerFocused: true,
                conversation: 'nudge-done',
            },
        ],
    },
};
