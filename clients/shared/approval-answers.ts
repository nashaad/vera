// The answers an approval offers, in order, and the words after "always allow", shared by the
// desktop and the TUI. It reads only the grant predicates the host sends with the request and the
// session's mode, so both clients offer the same answers and neither renumbers on its own.

import { baseName } from "./approval-headline.ts";

export type ApprovalDecision = "allow_once" | "allow_similar" | "allow_always" | "deny";

// The predicate fields read here; the full shape is PermissionPredicate in src/engine/permissions.ts.
export interface ApprovalAnswerGrant {
    readonly tool?: string;
    readonly verb?: string;
    readonly path?: string;
    readonly operation?: string;
    readonly host?: string;
    readonly executable?: string;
}

export interface ApprovalAnswersInput {
    readonly grants: readonly ApprovalAnswerGrant[];
    // A subagent's call: it takes a one-call answer and no typed answer.
    readonly subagent: boolean;
    // An ask from permission_rules, which no grant or saved preference can lift.
    readonly restricted: boolean;
    // The session's mode, empty when the client does not know it yet.
    readonly mode: string;
    // The modes the session offers.
    readonly modes: readonly string[];
}

export interface ApprovalAnswer {
    readonly decision: ApprovalDecision;
    readonly label: string;
    // Answer 3 runs the call once, then switches the session to auto.
    readonly switchToAuto?: true;
}

export const APPROVE_FOR_ME_MODE = "auto";

const THIS_CHAT = "Yes, for this chat";
const THIS_TIME = "Yes, this time";
const DENY_LABEL = "No";
const SWITCH_LABEL = "Yes, and switch to Approve for me";

const VERB_WORDS: Readonly<Record<string, string>> = {
    read: "reading",
    write: "writing",
    delete: "deleting",
};

// The operation table in the contract, word for word; web.fetch and web.download depend on the host.
const OPERATION_WORDS: Readonly<Record<string, string>> = {
    "agent.close": "closing helper agents",
    "agent.inbox": "reading helper agents' messages",
    "agent.message": "messaging helper agents",
    "agent.roster": "listing helper agents",
    "agent.spawn": "starting helper agents",
    "git.clone": "git clones",
    "git.commit": "git commits",
    "git.fetch": "git fetches",
    "git.ls_remote": "reading git remotes",
    "git.pull": "git pulls",
    "git.push": "git pushes",
    "git.remote_update": "git remote updates",
    "memory.write": "saving to memory",
    "process.kill": "stopping processes",
    "process.read": "reading process output",
    "web.search": "web searches",
};

export function approvalAnswers(input: ApprovalAnswersInput): readonly ApprovalAnswer[] {
    const answers: ApprovalAnswer[] = [];
    const remembers = !input.subagent
        && !input.restricted
        && input.grants.length > 0;
    if (remembers) {
        answers.push({ decision: "allow_similar", label: THIS_CHAT });
        answers.push({
            decision: "allow_always",
            label: "Yes, and always allow " + alwaysAllowWords(input.grants),
        });
    } else {
        answers.push({ decision: "allow_once", label: THIS_TIME });
    }
    if (offersAuto(input)) {
        answers.push({
            decision: "allow_once",
            label: SWITCH_LABEL,
            switchToAuto: true,
        });
    }
    answers.push({ decision: "deny", label: DENY_LABEL });
    return answers;
}

// Offered on a prompt while the session is in ask, auto is available, and the call is the
// conversation's own; not for an ask from permission_rules.
function offersAuto(input: ApprovalAnswersInput): boolean {
    return !input.subagent
        && !input.restricted
        && input.mode === "ask"
        && input.modes.includes(APPROVE_FOR_ME_MODE);
}

export function alwaysAllowWords(
    grants: readonly ApprovalAnswerGrant[],
): string {
    if (grants.length === 0) return "actions like this";
    const paths = grants.filter((grant) =>
        grant.path !== undefined && grant.operation === undefined
    );
    if (paths.length > 0 && paths.length === grants.length) {
        return pathWords(paths);
    }
    const operations = grants.filter((grant) => grant.operation !== undefined);
    if (operations.length === 1 && grants.length === 1) {
        return operationWords(operations[0]!.operation!, operations[0]!.host);
    }
    if (
        grants.length === 1
        && grants[0]!.executable !== undefined
        && VERB_WORDS[grants[0]!.verb ?? ""] === undefined
    ) {
        return `${grants[0]!.executable} commands`;
    }
    return "actions like this";
}

function pathWords(grants: readonly ApprovalAnswerGrant[]): string {
    const paths = [...new Set(grants.map((grant) => grant.path!))];
    const verbs = new Set(grants.map((grant) => grant.verb ?? "unknown"));
    const verb = verbs.size === 1
        ? VERB_WORDS[[...verbs][0]!] ?? "changing"
        : "changing";
    const what = paths.length === 1
        ? baseName(paths[0]!)
        : `${paths.length} files`;
    return `${verb} ${what}`;
}

function operationWords(
    operation: string,
    host: string | undefined,
): string {
    if (operation === "web.fetch") {
        return host ?? "web fetches";
    }
    if (operation === "web.download") {
        return host === undefined ? "web downloads" : `downloads from ${host}`;
    }
    return OPERATION_WORDS[operation] ?? operation;
}
