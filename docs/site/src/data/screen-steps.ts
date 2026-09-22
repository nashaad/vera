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
    | 'rules-start' | 'rules-asked' | 'rules-read' | 'rules-read-again' | 'rules-done';

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

export type ContextRole = 'system' | 'you' | 'model' | 'tool' | 'rule';

export interface ContextEntry {
    role: ContextRole;
    text: string;
    // Roughly how much room it takes, in lines; a file read is the big one.
    lines?: number;
}

// What the model sees during the tool-call walkthrough, in the order it arrives.
export const CONTEXT_ENTRIES: ContextEntry[] = [
    { role: 'system', text: 'instructions, tools, project rules', lines: 2 },
    { role: 'you', text: 'mark the X in src/map.ts and run the tests' },
    { role: 'model', text: 'read src/map.ts' },
    { role: 'tool', text: 'src/map.ts, 42 lines of code', lines: 3 },
    { role: 'model', text: 'edit src/map.ts' },
    { role: 'tool', text: 'edited src/map.ts' },
    { role: 'model', text: 'bash: bun test' },
    { role: 'tool', text: '12 pass, 0 fail' },
    { role: 'model', text: 'Marked the X at the north cove. The map tests pass.' },
];

// A scoped rule is a hidden message after the tool result, so only this panel shows it arriving.
const RULE_CONTEXT: ContextEntry[] = [
    { role: 'system', text: 'instructions, tools, always-on rules', lines: 2 },
    { role: 'you', text: 'hide a secret compartment in src/treasure/chest.ts' },
    { role: 'model', text: 'read src/treasure/chest.ts' },
    { role: 'tool', text: 'src/treasure/chest.ts, 88 lines of code', lines: 3 },
    { role: 'rule', text: '.vera/rules/treasure.md: never bury the map with the loot', lines: 2 },
    { role: 'model', text: 'read src/treasure/map.ts' },
    { role: 'tool', text: 'src/treasure/map.ts, 40 lines of code', lines: 2 },
    { role: 'model', text: 'edit src/treasure/chest.ts' },
    { role: 'tool', text: 'edited src/treasure/chest.ts' },
    { role: 'model', text: 'Hid the compartment. The map stays out of the chest.' },
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
    | 'scoped-rule';

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
    'scoped-rule': {
        title: 'A scoped rule arrives with the file',
        context: RULE_CONTEXT,
        steps: [
            {
                action: 'Ask for a change under `src/treasure/`.',
                keys: [],
                composer: 'hide a secret compartment in src/treasure/chest.ts',
                composerFocused: true,
                conversation: 'rules-start',
                context: 1,
            },
            {
                keys: ['Enter'],
                result: 'The model asks to read `src/treasure/chest.ts`.',
                composer: '',
                composerFocused: true,
                conversation: 'rules-asked',
                working: true,
                context: 3,
                fresh: 2,
            },
            {
                keys: [],
                result: 'Vera reads it. The file goes back to the model.',
                composer: '',
                composerFocused: true,
                conversation: 'rules-read',
                working: true,
                context: 4,
            },
            {
                keys: [],
                result: 'The path matches `src/treasure/**`, so `.vera/rules/treasure.md` joins the next request. The screen shows nothing.',
                composer: '',
                composerFocused: true,
                conversation: 'rules-read',
                working: true,
                context: 5,
            },
            {
                keys: [],
                result: 'The model reads another file under `src/treasure/`. The rule is already there, so it does not arrive again.',
                composer: '',
                composerFocused: true,
                conversation: 'rules-read-again',
                working: true,
                context: 7,
                fresh: 2,
            },
            {
                keys: [],
                result: 'It follows the rule in its edit, then answers.',
                composer: '',
                composerFocused: true,
                conversation: 'rules-done',
                context: 10,
                fresh: 3,
            },
        ],
    },
};
