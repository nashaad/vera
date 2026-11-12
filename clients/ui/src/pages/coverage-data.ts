// "window": the desktop does it. "partial": part of it, the note says which part.
// "terminal": the terminal client does it and the window does not; the note names how.
// "host": no client can, because the host does not serve it.
export type CoverageStatus = "window" | "partial" | "terminal" | "host";

export interface Behavior {
    readonly text: string;
    readonly status: CoverageStatus;
    readonly note?: string;
}

export interface CoveragePhase {
    readonly name: string;
    readonly items: readonly Behavior[];
}

const inWindow = (text: string, note?: string): Behavior => ({ text, status: "window", ...(note ? { note } : {}) });
const partial = (text: string, note: string): Behavior => ({ text, status: "partial", note });
const inTerminal = (text: string, note: string): Behavior => ({ text, status: "terminal", note });
const notServed = (text: string, note: string): Behavior => ({ text, status: "host", note });

export const COVERAGE: readonly CoveragePhase[] = [
    {
        name: "Cold launch",
        items: [
            inWindow("The window runs the installed vera boot and attaches to the host it names"),
            inWindow("A host that does not answer is started, then attached"),
            inWindow("Reconnect runs vera boot, which repairs stale runtime state"),
            inWindow("A busy host is restarted only when you answer Yes"),
            inTerminal("Keybinding warnings are named at startup and never block launch", "Window shortcuts are fixed"),
            inTerminal("Tips are shown in the terminal and recorded once shown", "The window shows no tips"),
            inTerminal("Connecting a provider is done in the terminal with /provider", "Settings > Providers lists it once connected"),
        ],
    },
    {
        name: "Provider wizard",
        items: [
            inTerminal("Known providers are offered with their endpoint prefilled", "/provider in the terminal"),
            inTerminal("Connecting asks for an endpoint and an API key", "/provider in the terminal"),
            inTerminal("A failed save names the cause and keeps the input", "/provider in the terminal"),
            inTerminal("Outrider guided setup can install and download a local model", "Off by default. Enable with /configure"),
            inWindow("Refresh lists a provider's models again from the provider", "Settings > Providers"),
            partial("Providers can be forgotten, and forgetting asks first", "Connecting is done in the terminal with /provider"),
        ],
    },
    {
        name: "Composing a prompt",
        items: [
            inWindow("Type a message, and Shift+Enter adds a line"),
            inTerminal("A mistyped slash command names the one you probably meant", "The window has the command palette on Cmd+K"),
            partial("Dropped image files become Image chips on the message", "Other files are not attached in the window"),
            inWindow("Pasted text goes into the box and does not send"),
            inTerminal("Ctrl+G moves focus between conversation panes", "The window has no pane focus key"),
        ],
    },
    {
        name: "Turn starts",
        items: [
            inWindow("Enter sends the message, and it shows in the conversation"),
            partial("A running turn shows a stop button in place of send", "Escape does not stop it; Enter on an empty box does"),
            partial("A running turn shows one line with three dots and a sweep across its label", "No activity strip glyphs"),
            inTerminal("The activity strip's motion is set from Off to 3", "/settings, then Animation. Window has Reduce motion, which stops the dots and sweep"),
            inWindow("The status line says Thinking, then the turn clock after two seconds"),
            partial("The status line shows elapsed time and the tokens streamed so far", "The tokens are the window's estimate; the host sends no count until the turn ends"),
            inWindow("The status line names the running tool and its target, and opens the calls in progress"),
            inWindow("The status line says Retrying on the model while the host retries"),
            inWindow("The status line says Waiting on you while an approval or question is open"),
            inWindow("New words in the reply being written fade in"),
            inWindow("Composer pills show provider, model, effort and approval mode"),
        ],
    },
    {
        name: "Thinking streams",
        items: [
            partial("Reasoning arrives as a Thought that is still being written", "Off by default; the showReasoning flag turns it on"),
            partial("A pending Thought shows three dots and its latest line", "Off by default; the showReasoning flag turns it on"),
            partial("The latest line is replaced as new reasoning arrives", "Off by default; the showReasoning flag turns it on"),
            partial("Reasoning ends and the live line goes", "Off by default; the showReasoning flag turns it on"),
            partial("A finished thought shows Thought and its length in seconds", "Off by default; the showReasoning flag turns it on"),
            partial("Thought opens to show its full text", "Off by default; the showReasoning flag turns it on"),
        ],
    },
    {
        name: "Tool calls",
        items: [
            inWindow("A running call has no row of its own; the status line names it"),
            inWindow("When text resumes, a run of calls becomes one past-tense line such as Ran 3 commands, read 2 files"),
            inWindow("Calls that follow one another join one line"),
            inWindow("A line opens to one dimmed row per call, a verb and its target"),
            inWindow("A shell call opens to a box with its command, a copy button and its output"),
            inWindow("A call that only wrote or edited files draws no line when the changed-files card names them"),
            inWindow("A failed call is marked on its row, and the line says how many failed"),
            inWindow("A row opens to its output"),
            inWindow("Copy Conversation copies the loaded messages as Markdown", "Session menu"),
        ],
    },
    {
        name: "Expanding and re-collapsing",
        items: [
            inTerminal("Ctrl+T expands tool details", "The window opens each line on click"),
            inWindow("The page follows new steps only until you scroll up"),
        ],
    },
    {
        name: "Approval interrupts the turn",
        items: [
            inWindow("A tool that needs permission shows a card, and the turn waits"),
            inWindow("The card's title is the action and its target, such as Create index.html"),
            inWindow("A subagent's request offers Allow once and Deny only"),
            inWindow("The card shows the command or arguments and any warning"),
            inWindow("Allow once, Allow similar, Always and Deny, on keys 1 to 4"),
            inWindow("Allow similar and Always appear only when Vera offers them"),
            inWindow("Deny refuses the call and the turn goes on without it"),
            partial("An answered approval leaves nothing, or one muted line when denied", "Settings > Appearance > Past approvals keeps the full cards"),
            inWindow("Why? shows Vera's reason and what Allow similar would allow"),
            inWindow("Always adds a standing rule, listed in the approval pill", "Approval pill, Every session allows"),
        ],
    },
    {
        name: "Queueing while it works",
        items: [
            inWindow("A message sent during a turn waits in the queue"),
            inWindow("Escape releases the oldest queued message and ends the running turn"),
            inWindow("A queued message is sent when the running turn ends"),
            inTerminal("Ctrl+C stops the active turn and leaves queued work alone", "The window uses its stop button"),
            inWindow("With the box empty, Enter with nothing queued stops the turn"),
        ],
    },
    {
        name: "Turn ends",
        items: [
            inWindow("Replies render headings, lists, bold, italics, code and links"),
            inWindow("A turn that edits files ends with a card of its patches"),
            partial("Names the model that ran, when it was not the one picked", "The reason for the swap is not shown"),
            inWindow("The send button returns when the turn ends"),
            inTerminal("Ctrl+T lists the actions the classifier allowed and why", "The window does not list them"),
            inWindow("Show earlier messages at the top loads the page before"),
        ],
    },
    {
        name: "Context filling up",
        items: [
            inWindow("The context pill shows how full the context window is"),
            inWindow("Compact runs a compaction on demand and reports the result", "Session menu, Compact"),
            inWindow("The context popover splits the total into its parts"),
            inWindow("Automatic compaction runs near the limit and leaves a notice", "The context popover marks where it starts"),
            inWindow("List every message shows the size of each message"),
            inTerminal("Overrides refuses a context setting that contradicts another", "/settings, then Overrides"),
        ],
    },
    {
        name: "Rewind and fork",
        items: [
            inWindow("Rewind or Fork lists your prompts, newest first", "Session menu, Rewind or Fork"),
            inWindow("Rewind sets later messages aside and puts the prompt back in the composer"),
            inWindow("Fork from here starts a new session at that prompt"),
        ],
    },
    {
        name: "Subagents",
        items: [
            inWindow("A subagent Vera starts is listed in the session menu"),
            inWindow("Subagents lists each subagent with its status", "Session menu, Subagents"),
            inWindow("Open shows a subagent in a second pane beside the conversation"),
            inWindow("Go to opens a subagent's own page, and Back returns"),
            inWindow("Cmd+Alt+A cycles one pane, a pane beside, or a pane below"),
            inWindow("A subagent whose model is swapped gets a line marked subagent"),
        ],
    },
    {
        name: "Conversation switching",
        items: [
            inWindow("The Sessions view groups sessions by folder", "Sidebar"),
            inTerminal("/clear starts a new conversation in place", "The window starts one from New Chat"),
            inTerminal("/rename names the conversation or removes its name", "The window has no rename"),
            inTerminal("/resume asks whether to stop or keep the one on screen", "The window opens any session from the sidebar"),
            inTerminal("/clone duplicates the conversation", "/clone in the terminal"),
            inTerminal("/close parks a live conversation and keeps its saved file", "/close in the terminal"),
            inTerminal("Ctrl+Shift+Left and Right cycle live conversations", "Cmd+[ and Cmd+] move back and forward in the window"),
        ],
    },
    {
        name: "Search",
        items: [
            inWindow("Search finds sessions by their messages, commands, edits and titles"),
            inTerminal("Ctrl+F searches the conversation on screen", "The window has Search, scoped to This conversation"),
            inWindow("Search covers every session, or only This conversation"),
        ],
    },
    {
        name: "Settings and models",
        items: [
            inWindow("The model pill menu searches models"),
            inWindow("Picking a model switches this conversation"),
            inWindow("A model can be pinned to the shortlist with its pin button", "Model pill search or Models browser"),
            inWindow("The Defaults tab shows the models new sessions and jobs use", "Models browser"),
            partial("Connected providers can be refreshed and forgotten", "Connecting is done in the terminal with /provider"),
            inWindow("The composer's model and effort pills change them"),
            inWindow("The effort pill's slider returns to the model's default"),
            notServed("Auto picks a model for each turn", "The model menu shows it disabled"),
            notServed("Fast answers sooner and thinks less between tool calls", "The model menu shows it disabled"),
            inWindow("The theme is chosen from View > Theme", "View menu, or Settings > Appearance"),
            inTerminal("/nudges adds a standing preference", "Help > Standing Nudges points there"),
            inTerminal("/configure chooses a configuration file to open in the editor", "Window lists the files without editing them"),
            inWindow("Probe it sends one short request and reports whether the model passed", "Models browser, model details"),
            inTerminal("Shortcuts are remapped in tui.json and shown in /help", "Window shortcuts cannot be changed"),
            inTerminal("A bad keybinding is named at startup and ignored", "Window shortcuts are fixed"),
        ],
    },
    {
        name: "Extensions",
        items: [
            partial("The Extensions sheet has a row for each extension that failed to load", "Terminal /extensions lists every installed copy"),
            inTerminal("Each row shows the extension's id, version and status", "/extensions in the terminal"),
            inTerminal("Space enables or disables a copy at once", "/extensions, Space. Host code needs Reconnect host"),
            inTerminal("Remove deletes a managed copy and leaves its source alone", "/extensions, then Details, then Remove"),
            inTerminal("/extension install <path> installs from the composer", "The window does not install"),
            inTerminal("A host-side extension change notes that a restart is needed", "The window has no extension controls"),
            inTerminal("Installed skills and extensions add commands to /help", "/help in the terminal"),
            notServed("Browse extensions and skills that are not installed", "Customize > Discover says there is no catalog"),
        ],
    },
    {
        name: "Diagnostics",
        items: [
            inWindow("Session Diagnostics lists the session's facts and the host's", "Copy puts them on the clipboard as text"),
            partial("Check Vera's Health checks the connection and what the window knows", "Full check is vera doctor in a terminal"),
            inTerminal("/usage opens local session usage and cost", "/usage in the terminal"),
            inTerminal("/failure-report writes a report of recorded model failures", "Help > Model Failures points there"),
            inWindow("Reconnect on the banner is the next step when the connection drops", "Banner button after a lost connection"),
            inTerminal("A dropped connection gets one automatic restart", "The window shows the banner with Reconnect"),
            inTerminal("/diagnostics switches between the Session and Vera reports", "The window shows both on one sheet"),
        ],
    },
    {
        name: "Workspaces",
        items: [
            inWindow("The sidebar hides and shows with Cmd+B"),
            inWindow("A workspace page shows the folder's git branch"),
            partial("New chat here starts a session, and there is no rename", "The workspace page has no rename action"),
        ],
    },
    {
        name: "The plan pane",
        items: [
            inWindow("The Plan view shows the newest checklist Vera wrote", "Right pane, Plan view"),
            inWindow("The Plan view marks the item just finished"),
        ],
    },
    {
        name: "Settings",
        items: [
            inWindow("Settings opens as a page on Cmd+comma", "A page, not a sheet. Also in the Go menu"),
            inWindow("Settings search filters sections by name and keywords"),
            inWindow("Settings lists its sections on the left and opens on Appearance"),
            inWindow("Each section names where its values come from"),
            partial("Devices lists this window as the one active connection", "Other attached clients are not listed"),
            partial("The Defaults tab shows each job's model", "Choosing a job's model is done in the terminal"),
        ],
    },
];
