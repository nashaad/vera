// @ts-nocheck
/**
 * Lift AgentRegistry method groups into sibling modules.
 * Class methods become thin delegates. `start` stays on the class.
 *
 *   bun run scripts/agent-registry-lift-methods.ts lifecycle
 */
const fs = require("node:fs");
const ts = require("/Users/nash/Projects/vera/node_modules/typescript/lib/typescript.js");

const SRC = "src/host/agent-registry.ts";
const GROUPS = {
    lifecycle: {
        file: "src/host/agent-registry/lifecycle.ts",
        ns: "registryLifecycle",
        names: [
            "create",
            "closeAgent",
            "ownedTreeIds",
            "closeAgentTree",
            "closeDescendantTree",
            "reapClosedAgent",
            "liveDescendantsOf",
            "createWithKind",
            "resume",
            "branch",
            "trashSession",
            "find",
            "commitBranch",
            "syncBranchContext",
            "arcNameOf",
            "agentIdForArcSession",
            "identityKeyTaken",
            "bindSessionIdentity",
            "claimSessionIdentityKey",
            "idleForShutdown",
            "idleForReplacement",
            "close",
            "reserveId",
            "requireOpen",
        ],
    },
    settings: {
        file: "src/host/agent-registry/settings.ts",
        ns: "registrySettings",
        names: [
            "modelsForClient",
            "isKnownProvider",
            "readHostModelSettings",
            "reviewerDefault",
            "readReviewer",
            "applyReviewerPatch",
            "resolveModelPatch",
            "updateModelSettings",
            "applyModelSettings",
            "effectiveDefaultPair",
            "originFor",
            "updateSessionModelSettings",
            "applySessionModelSettings",
            "sessionModelSettingsHistory",
            "poolAdd",
            "applyPoolAddEffect",
            "refreshHostCatalog",
            "refreshCatalog",
            "poolRemove",
            "poolName",
            "poolMove",
        ],
    },
    wear: {
        file: "src/host/agent-registry/wear.ts",
        ns: "registryWear",
        names: [
            "updateSessionPermissionMode",
            "applySessionPermissionMode",
            "leaveAgentThatForbidsAccess",
            "wornAgentDefaultPair",
            "wornAgentPosture",
            "listAgentsFor",
            "listSkillsFor",
            "decideSkillInvocationFor",
            "agentCatalogFor",
            "wearAgentFor",
            "applyAgentWear",
            "adoptAgentDefaultPair",
            "reconcileResumedAgentWear",
            "updateAgentDefaultPairFor",
            "updateApprovalMode",
            "applyApprovalMode",
            "approvalModeOf",
        ],
    },
    roster: {
        file: "src/host/agent-registry/roster.ts",
        ns: "registryRoster",
        names: [
            "renameSession",
            "updateSessionName",
            "onRosterChanged",
            "notifyRosterChanged",
            "list",
            "workFacts",
            "scheduleWorkFacts",
            "applyAgentRosterEffect",
            "applyAgentSendEffect",
            "wakeForPeerMessage",
            "applyAgentInboxEffect",
            "requestInboxAdmission",
        ],
    },
    subagent: {
        file: "src/host/agent-registry/subagent.ts",
        ns: "registrySubagent",
        names: [
            "workerAdapterSpecFor",
            "workerExtensions",
            "pushWorkerState",
            "pushWorkerStateEverywhere",
            "liveWorkerCount",
            "runInWorker",
            "requestMissingSubagentConfiguration",
            "scheduleSubagentConfigurationBatch",
            "processMissingSubagentConfiguration",
            "resolveConfiguredSubagentLaunch",
            "finishSubagentConfigurationBatch",
            "completeSubagentConfigurationBatch",
            "finishSubagentChoices",
            "settlePendingSubagentLaunch",
            "spawnAsyncSubagent",
            "messageSubagent",
            "closeSubagent",
            "trackAsyncSubagentTurn",
            "monitorAsyncSubagent",
            "notifyParent",
            "deliverBackgroundResult",
            "relayChildToolApproval",
            "trackDelivery",
        ],
    },
};

const groupName = process.argv[2];
const group = GROUPS[groupName];
if (!group) {
    console.error(`usage: bun run scripts/agent-registry-lift-methods.ts <${Object.keys(GROUPS).join("|")}>`);
    process.exit(1);
}

function fail(message) {
    console.error(message);
    process.exit(1);
}

function applyReplacements(source, replacements) {
    const sorted = [...replacements].sort((a, b) => {
        if (b.start !== a.start) return b.start - a.start;
        return b.end - a.end;
    });
    for (let i = 0; i < sorted.length - 1; i++) {
        const a = sorted[i];
        const b = sorted[i + 1];
        if (a.start < b.end && a.end > b.start) {
            fail(`overlapping replacements at ${b.start}-${b.end} and ${a.start}-${a.end}`);
        }
    }
    let out = source;
    for (const r of sorted) out = out.slice(0, r.start) + r.text + out.slice(r.end);
    return out;
}

function hasAsync(member) {
    return ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
        ?? false;
}

function collectIdents(node, into) {
    if (ts.isIdentifier(node)) {
        const parent = node.parent;
        if (ts.isPropertyAccessExpression(parent) && parent.name === node) return;
        if (ts.isMetaProperty(parent)) return;
        if (ts.isPropertyAssignment(parent) && parent.name === node) return;
        if (
            (ts.isMethodDeclaration(parent) || ts.isFunctionDeclaration(parent))
            && parent.name === node
        ) return;
        if (ts.isLabeledStatement(parent) && parent.label === node) return;
        into.add(node.text);
        return;
    }
    ts.forEachChild(node, (child) => collectIdents(child, into));
}

function rewriteThis(source, body) {
    const replacements = [];
    function walk(node) {
        if (node.kind === ts.SyntaxKind.ThisKeyword) {
            replacements.push({ start: node.getStart(), end: node.getEnd(), text: "reg" });
            return;
        }
        ts.forEachChild(node, walk);
    }
    walk(body);
    return applyReplacements(source.slice(body.getStart(), body.getEnd()), replacements.map((r) => ({
        start: r.start - body.getStart(),
        end: r.end - body.getStart(),
        text: r.text,
    })));
}

function paramCallName(param) {
    return param.name.getText();
}

function importMap(sf) {
    const values = new Map();
    const types = new Map();
    for (const stmt of sf.statements) {
        if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
        const spec = stmt.moduleSpecifier.text;
        const clause = stmt.importClause;
        const typeOnly = clause.isTypeOnly === true;
        if (clause.name) {
            (typeOnly ? types : values).set(clause.name.text, spec);
        }
        const named = clause.namedBindings;
        if (named && ts.isNamedImports(named)) {
            for (const el of named.elements) {
                const name = el.name.text;
                if (typeOnly || el.isTypeOnly) types.set(name, spec);
                else values.set(name, spec);
            }
        }
    }
    return { values, types };
}

function renderImports(used, maps) {
    const valueBySpec = new Map();
    const typeBySpec = new Map();
    for (const name of used) {
        if (maps.values.has(name)) {
            const spec = maps.values.get(name);
            let set = valueBySpec.get(spec);
            if (!set) {
                set = new Set();
                valueBySpec.set(spec, set);
            }
            set.add(name);
            continue;
        }
        if (maps.types.has(name)) {
            const spec = maps.types.get(name);
            let set = typeBySpec.get(spec);
            if (!set) {
                set = new Set();
                typeBySpec.set(spec, set);
            }
            set.add(name);
        }
    }
    const specs = [...new Set([...valueBySpec.keys(), ...typeBySpec.keys()])]
        .sort((a, b) => {
            const aLocal = a.startsWith(".");
            const bLocal = b.startsWith(".");
            if (aLocal !== bLocal) return aLocal ? 1 : -1;
            return a.localeCompare(b);
        });
    const lines = [];
    for (const spec of specs) {
        const valueNames = [...(valueBySpec.get(spec) ?? [])].sort();
        const typeNames = [...(typeBySpec.get(spec) ?? [])]
            .filter((n) => !valueNames.includes(n))
            .sort();
        if (valueNames.length > 0 && typeNames.length > 0) {
            lines.push(
                `import { ${valueNames.join(", ")}, ${typeNames.map((n) => `type ${n}`).join(", ")} } from "${spec}";`,
            );
        } else if (valueNames.length > 0) {
            lines.push(`import { ${valueNames.join(", ")} } from "${spec}";`);
        } else if (typeNames.length > 0) {
            lines.push(`import type { ${typeNames.join(", ")} } from "${spec}";`);
        }
    }
    lines.push(`import type { AgentRegistry } from "../agent-registry.ts";`);
    return lines.join("\n");
}

const source = fs.readFileSync(SRC, "utf8");
const sf = ts.createSourceFile(SRC, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
let cls;
for (const stmt of sf.statements) {
    if (ts.isClassDeclaration(stmt) && stmt.name?.text === "AgentRegistry") cls = stmt;
}
if (!cls) fail("AgentRegistry not found");

const maps = importMap(sf);
const wanted = new Set(group.names);
const methods = [];
for (const member of cls.members) {
    if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
    if (!wanted.has(member.name.text)) continue;
    if (!member.body) fail(`${member.name.text} has no body`);
    methods.push(member);
}
const found = new Set(methods.map((m) => m.name.text));
for (const name of group.names) {
    if (!found.has(name)) fail(`missing method ${name}`);
}

const used = new Set();
const functions = [];
for (const member of methods) {
    collectIdents(member, used);
    const name = member.name.text;
    const asyncKw = hasAsync(member) ? "async " : "";
    const typeParams = member.typeParameters
        ? `<${member.typeParameters.map((t) => t.getText(sf)).join(", ")}>`
        : "";
    const params = member.parameters.map((p) => p.getText(sf));
    const allParams = [`reg: AgentRegistry`, ...params].join(", ");
    const ret = member.type ? `: ${member.type.getText(sf)}` : "";
    const body = rewriteThis(source, member.body);
    const jsdoc = member.jsDoc?.length
        ? `${source.slice(member.jsDoc[0].pos, member.getStart(sf)).trim()}\n`
        : "";
    functions.push(
        `${jsdoc}export ${asyncKw}function ${name}${typeParams}(${allParams})${ret} ${body}`,
    );
}

used.delete("reg");
used.delete("this");
const header = `// Lifted ${groupName} methods from AgentRegistry. Callers keep registry.foo().\n`;
const dest = `${header}${renderImports(used, maps)}\n\n${functions.join("\n\n")}\n`;
fs.writeFileSync(group.file, dest);

const replacements = [];
for (const member of methods) {
    const name = member.name.text;
    const args = ["this", ...member.parameters.map(paramCallName)].join(", ");
    const sigEnd = member.body.getStart(sf);
    const sig = source.slice(member.getStart(sf), sigEnd).trimEnd();
    const lead = source.slice(member.getFullStart(), member.getStart(sf));
    replacements.push({
        start: member.getFullStart(),
        end: member.getEnd(),
        text: `${lead}${sig} {\n        return ${group.ns}.${name}(${args});\n    }`,
    });
}

let classOut = applyReplacements(source, replacements);
const importLine = `import * as ${group.ns} from "./agent-registry/${group.file.split("/").pop()}";\n`;
const lastImport = [...sf.statements].reverse().find((s) => ts.isImportDeclaration(s));
if (!lastImport) fail("no imports");
const insertAt = lastImport.getEnd();
const prefix = classOut.slice(0, insertAt);
const suffix = classOut.slice(insertAt);
const nl = suffix.startsWith("\n") ? "" : "\n";
classOut = `${prefix}\n${importLine}${nl}${suffix}`;
fs.writeFileSync(SRC, classOut);
console.log(`lifted ${methods.length} ${groupName} methods -> ${group.file}`);
