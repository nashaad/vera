// The question an approval asks, in words, shared by the desktop and the TUI. It reads only the
// grant predicates the host sends with the request, so both clients say the same thing.

// The predicate fields read here; the full shape is PermissionPredicate in src/engine/permissions.ts.
export interface HeadlineGrant {
    readonly tool?: string;
    readonly verb?: string;
    readonly path?: string;
    readonly operation?: string;
    readonly executable?: string;
}

export interface ApprovalHeadlineInput {
    readonly tool: string;
    readonly input: Readonly<Record<string, unknown>>;
    readonly grants: readonly HeadlineGrant[];
    readonly shell: boolean;
    // The session's working folder, when the client knows it.
    readonly workspace?: string;
    readonly chat: boolean;
}

export interface ApprovalHeadline {
    readonly question: string;
    // The folder the action lands in, unshortened; each client shortens it for display.
    readonly folder?: string;
    // True when the question does not say what a command does, so the command shows unfolded.
    readonly commandOpen: boolean;
}

const VERB_WORDS: Readonly<Record<string, string>> = {
    read: "Read",
    write: "Write",
    delete: "Delete",
};

const OPERATION_QUESTIONS: Readonly<Record<string, string>> = {
    "agent.close": "Close a helper agent?",
    "agent.inbox": "Read a helper agent's messages?",
    "agent.message": "Message a helper agent?",
    "agent.roster": "List the helper agents?",
    "agent.spawn": "Start a helper agent?",
    "git.clone": "Clone a git repository?",
    "git.commit": "Make a git commit?",
    "git.fetch": "Fetch from a git remote?",
    "git.ls_remote": "Read a git remote?",
    "git.pull": "Pull from a git remote?",
    "git.push": "Push to a git remote?",
    "git.remote_update": "Update from git remotes?",
    "memory.write": "Save to memory?",
    "process.kill": "Stop a process?",
    "process.read": "Read a process's output?",
    "web.download": "Download a file from the web?",
    "web.fetch": "Fetch a web page?",
    "web.search": "Search the web?",
};

const RUN_COMMAND = "Run this command?";

// Undefined when the grants say too little; the client then keeps its own tool title.
export function approvalHeadline(request: ApprovalHeadlineInput): ApprovalHeadline | undefined {
    const grants = request.grants;
    const paths = grants.filter((grant) => grant.path !== undefined && grant.operation === undefined);
    if (paths.length > 0 && paths.length === grants.length) return pathHeadline(request, paths);
    const operations = grants.filter((grant) => grant.operation !== undefined);
    if (operations.length === 1 && grants.length === 1) {
        return { question: operationQuestion(operations[0]!.operation!, request.input), commandOpen: false };
    }
    if (grants.length === 1 && grants[0]!.executable !== undefined && grants[0]!.verb !== "read"
        && grants[0]!.verb !== "write" && grants[0]!.verb !== "delete") {
        return { question: `Run ${grants[0]!.executable}?`, commandOpen: true };
    }
    return request.shell ? { question: RUN_COMMAND, commandOpen: true } : undefined;
}

function pathHeadline(request: ApprovalHeadlineInput, grants: readonly HeadlineGrant[]): ApprovalHeadline {
    const paths = [...new Set(grants.map((grant) => grant.path!))];
    const verbs = new Set(grants.map((grant) => grant.verb ?? "unknown"));
    const verb = verbs.size === 1 ? VERB_WORDS[[...verbs][0]!] ?? "Change" : "Change";
    const what = paths.length === 1 ? baseName(paths[0]!) : `${paths.length} files`;
    const folder = paths.length === 1 ? parentOf(paths[0]!) : commonParent(paths);
    return {
        question: `${verb} ${what}${outsidePhrase(request, paths)}?`,
        ...(folder === undefined ? {} : { folder }),
        commandOpen: false,
    };
}

function outsidePhrase(request: ApprovalHeadlineInput, paths: readonly string[]): string {
    const workspace = request.workspace;
    if (workspace === undefined || workspace.length === 0) return "";
    if (!paths.every((path) => !isWithin(path, workspace))) return "";
    return request.chat ? " outside this chat's folder" : ` outside the ${baseName(workspace)} folder`;
}

function operationQuestion(operation: string, input: Readonly<Record<string, unknown>>): string {
    if (operation === "web.fetch") {
        const host = hostOf(input.url);
        if (host !== undefined) return `Fetch ${host}?`;
    }
    return OPERATION_QUESTIONS[operation] ?? `Allow ${operation}?`;
}

function hostOf(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    try {
        const host = new URL(value).host;
        return host.length === 0 ? undefined : host;
    } catch {
        return undefined;
    }
}

function parts(path: string): readonly string[] {
    return path.split(/[\\/]/).filter((part) => part.length > 0);
}

function separatorOf(path: string): string {
    return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

export function baseName(path: string): string {
    return parts(path).at(-1) ?? path;
}

function joinParts(sample: string, segments: readonly string[]): string | undefined {
    if (segments.length === 0) return undefined;
    const separator = separatorOf(sample);
    const lead = sample.startsWith(separator) ? separator : "";
    return `${lead}${segments.join(separator)}`;
}

function parentOf(path: string): string | undefined {
    return joinParts(path, parts(path).slice(0, -1));
}

function commonParent(paths: readonly string[]): string | undefined {
    const split = paths.map((path) => parts(path).slice(0, -1));
    const first = split[0] ?? [];
    let shared = 0;
    while (shared < first.length && split.every((segments) => segments[shared] === first[shared])) shared += 1;
    return joinParts(paths[0]!, first.slice(0, shared));
}

function isWithin(path: string, folder: string): boolean {
    const inner = parts(path);
    const outer = parts(folder);
    return outer.length <= inner.length && outer.every((segment, index) => inner[index] === segment);
}
