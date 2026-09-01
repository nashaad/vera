// Lifted wear methods from AgentRegistry. Callers keep registry.foo().
import { findCatalogAgent, loadAgentCatalog, type AgentCatalog } from "../../agents/catalog.ts";
import { DEFAULT_AGENT, type AgentDefinition } from "../../agents/definition.ts";
import { agentSnapshotDrift, resolveAgentSnapshot } from "../../agents/wear.ts";
import { writeAgentDefaultPair } from "../../agents/writer.ts";
import { EngineEventBus } from "../../engine/events.ts";
import type { ModelTurnSettings } from "../../engine/model-settings.ts";
import { BUILT_IN_PERMISSION_MODE_NAMES, builtInPermissionMode, isApprovalMode, type ApprovalMode } from "../../engine/permissions.ts";
import { decideSkillInvocation, loadSkillCommandCatalog, type SkillCommandCatalog, type SkillInvocationDecision } from "../../skills/commands.ts";
import { sessionIsSubagent } from "../../store/session-store.ts";
import { delegationAllows } from "./helpers.ts";
import { RESUME_WEAR_REQUEST_ID, resolveInstructionRoot, samePair, type RegisteredAgentEntry } from "./support.ts";
import type { AgentRegistry } from "../agent-registry.ts";

/** The posture for this session alone, leaving the host default alone. */
export async function updateSessionPermissionMode(reg: AgentRegistry, id: string, mode: ApprovalMode): Promise<ApprovalMode | undefined> {
        const result = await reg.applySessionPermissionMode(id, mode);
        reg.pushWorkerState(id);
        return result;
    }

export async function applySessionPermissionMode(reg: AgentRegistry, id: string, mode: ApprovalMode): Promise<ApprovalMode | undefined> {
        const entry = reg.agents.get(id);
        if (
            entry === undefined
            || entry.agent.closed
            || entry.agent.failed
            || !isApprovalMode(mode)
            || (
                builtInPermissionMode(mode) === undefined
                && reg.options.permissionModes?.[mode] === undefined
            )
        ) {
            return undefined;
        }
        await reg.leaveAgentThatForbidsAccess(entry, id, mode);
        await entry.store.appendApprovalMode(
            mode,
            mode === reg.wornAgentPosture(entry) ? "agent-default" : "user",
        );
        entry.approvalMode = mode;
        return entry.approvalMode;
    }

/**
     * An explicit permission choice wins over an incompatible agent.
     *
     * The host owns this transition so `/permissions`, the HUD, and other
     * clients cannot disagree. The agent update is deliberately loud and
     * durable: the client receives a sticky transcript notice explaining why
     * the session returned to default.
     */
export async function leaveAgentThatForbidsAccess(reg: AgentRegistry, entry: RegisteredAgentEntry, id: string, mode: ApprovalMode): Promise<void> {
        const active = entry.agentWear;
        if (active?.forbiddenAccess?.includes(mode) !== true) return;
        const switched = await reg.wearAgentFor(id, DEFAULT_AGENT.name);
        if (switched === undefined) return;
        entry.events.emit({
            type: "agent_worn",
            update: {
                requestId: `permissions-${mode}`,
                ...switched,
                notice:
                    `Switched to default because ${active.name} does not allow ${mode.replaceAll("_", " ")} access.`,
            },
        });
    }

/**
     * The worn agent's default pair, resolved against the pool as it stands.
     *
     * Undefined when the agent names none, or names one the pool no longer
     * has: in both cases the effective default is the host's own, which is
     * what row 7 and row 9 of the origin table say.
     */
export function wornAgentDefaultPair(reg: AgentRegistry, entry: RegisteredAgentEntry): ModelTurnSettings | undefined {
        const pair = entry.agentWear?.defaultPair;
        if (pair === undefined) return undefined;
        const pooled = reg.options.readPool?.(entry.store.header.cwd) ?? [];
        const pooledEntry = pooled.find((candidate) =>
            candidate.poolName === pair.name
        );
        return pooledEntry === undefined ? undefined : {
            provider: pooledEntry.provider,
            model: pooledEntry.model,
            ...(pair.effort === undefined ? {} : { reasoningEffort: pair.effort }),
        } as ModelTurnSettings;
    }

/**
     * The worn agent's posture. Omitted on the agent means the host's current
     * default, resolved now rather than frozen at wear: editing the default
     * has to reach the sessions that never named one.
     */
export function wornAgentPosture(reg: AgentRegistry, entry: RegisteredAgentEntry): ApprovalMode | undefined {
        const named = entry.agentWear?.posture;
        return named !== undefined && isApprovalMode(named)
            ? named
            : reg.defaultApprovalMode;
    }

/** Every agent this session could wear, with the one in force named. */
export async function listAgentsFor(reg: AgentRegistry, id: string): Promise<{
        readonly worn: string;
        readonly agents: readonly {
            readonly name: string;
            readonly description?: string;
            readonly scope: "project" | "user" | "extension";
            readonly writable: boolean;
            readonly tools?: readonly string[];
            readonly skills?: readonly string[];
            readonly posture?: string;
            readonly forbiddenAccess?: readonly string[];
            readonly defaultPair?: {
                readonly name: string;
                readonly effort?: string;
            };
        }[];
        readonly notices: readonly string[];
    }> {
        const entry = reg.agents.get(id);
        if (entry === undefined) {
            return { worn: DEFAULT_AGENT.name, agents: [], notices: [] };
        }
        const catalog = await reg.agentCatalogFor(entry);
        return {
            worn: entry.agentWear?.name ?? DEFAULT_AGENT.name,
            agents: catalog.agents.map((agent) => ({
                name: agent.definition.name,
                ...(agent.definition.description === undefined
                    ? {}
                    : { description: agent.definition.description }),
                scope: agent.scope,
                writable: agent.writable,
                ...(agent.definition.tools === undefined
                    ? {}
                    : { tools: agent.definition.tools }),
                ...(agent.definition.skills === undefined
                    ? {}
                    : { skills: agent.definition.skills }),
                ...(agent.definition.posture === undefined
                    ? {}
                    : { posture: agent.definition.posture }),
                ...(agent.definition.forbiddenAccess === undefined
                    ? {}
                    : { forbiddenAccess: agent.definition.forbiddenAccess }),
                ...(agent.definition.defaultPair === undefined
                    ? {}
                    : { defaultPair: agent.definition.defaultPair }),
            })),
            notices: catalog.notices,
        };
    }

export async function listSkillsFor(reg: AgentRegistry, id: string): Promise<SkillCommandCatalog> {
        const entry = reg.agents.get(id);
        if (entry === undefined || entry.agent.closed || entry.agent.failed) {
            return { skills: [], warnings: ["Skill commands are unavailable."] };
        }
        return loadSkillCommandCatalog({
            projectRoot: resolveInstructionRoot(entry.store.header.cwd).path,
            ...(entry.agentWear?.skills === undefined
                ? {}
                : { allowedSkills: entry.agentWear.skills }),
        });
    }

export async function decideSkillInvocationFor(reg: AgentRegistry, id: string, name: string): Promise<SkillInvocationDecision> {
        const entry = reg.agents.get(id);
        if (entry === undefined || entry.agent.closed || entry.agent.failed) {
            return { allowed: false, reason: `/${name} is unavailable.` };
        }
        return decideSkillInvocation({
            projectRoot: resolveInstructionRoot(entry.store.header.cwd).path,
            name,
            ...(entry.agentWear?.skills === undefined
                ? {}
                : { allowedSkills: entry.agentWear.skills }),
            isSubagent: sessionIsSubagent(entry.store.header),
        });
    }

export async function agentCatalogFor(reg: AgentRegistry, entry: RegisteredAgentEntry): Promise<AgentCatalog> {
        return loadAgentCatalog({
            projectRoot: entry.store.header.cwd,
            permissionModes: [
                ...BUILT_IN_PERMISSION_MODE_NAMES,
                ...Object.keys(reg.options.permissionModes ?? {}),
            ],
            interactive: true,
            ...(reg.options.registeredAgents === undefined
                ? {}
                : { registered: reg.options.registeredAgents }),
        });
    }

/**
     * Put an agent on. Records the resolved definition, adopts its default
     * pair when nobody has dialled this session, and answers with what is now
     * in force.
     */
export async function wearAgentFor(reg: AgentRegistry, id: string, name: string): Promise<{
        readonly name: string;
        readonly tools?: readonly string[];
        readonly skills?: readonly string[];
        readonly posture?: string;
        readonly forbiddenAccess?: readonly string[];
        readonly notice?: string;
        readonly permissionChanged?: boolean;
    } | undefined> {
        const result = await reg.applyAgentWear(id, name);
        reg.pushWorkerState(id);
        return result;
    }

export async function applyAgentWear(reg: AgentRegistry, id: string, name: string): Promise<{
        readonly name: string;
        readonly tools?: readonly string[];
        readonly skills?: readonly string[];
        readonly posture?: string;
        readonly forbiddenAccess?: readonly string[];
        readonly notice?: string;
        readonly permissionChanged?: boolean;
    } | undefined> {
        const entry = reg.agents.get(id);
        if (entry === undefined || entry.agent.closed || entry.agent.failed) {
            return undefined;
        }
        const catalog = await reg.agentCatalogFor(entry);
        const found = findCatalogAgent(catalog, name);
        if (found === undefined) return undefined;
        const snapshot = resolveAgentSnapshot(found.definition);
        await entry.store.appendAgentWear(snapshot.name, snapshot);
        entry.agentWear = snapshot;
        let permissionChanged = false;
        if (snapshot.forbiddenAccess?.includes(entry.approvalMode) === true) {
            const fallback = snapshot.posture !== undefined
                    && !snapshot.forbiddenAccess!.includes(snapshot.posture)
                ? snapshot.posture
                : [
                    ...BUILT_IN_PERMISSION_MODE_NAMES,
                    ...Object.keys(reg.options.permissionModes ?? {}),
                ].find((mode) => !snapshot.forbiddenAccess!.includes(mode));
            if (fallback !== undefined && isApprovalMode(fallback)) {
                await entry.store.appendApprovalMode(fallback, "agent-default");
                entry.approvalMode = fallback;
                permissionChanged = true;
            }
        }
        const notice = await reg.adoptAgentDefaultPair(entry, found.definition);
        return {
            name: snapshot.name,
            ...(snapshot.tools === undefined ? {} : { tools: snapshot.tools }),
            ...(snapshot.skills === undefined
                ? {}
                : { skills: snapshot.skills }),
            ...(snapshot.posture === undefined
                ? {}
                : { posture: snapshot.posture }),
            ...(snapshot.forbiddenAccess === undefined
                ? {}
                : { forbiddenAccess: snapshot.forbiddenAccess }),
            ...(permissionChanged ? { permissionChanged: true } : {}),
            ...(notice === undefined ? {} : { notice }),
        };
    }

/**
     * Rows 7 to 9 of the origin table, in one place.
     *
     * A session the user has dialled keeps its pair: the override survives an
     * agent switch, which is the difference between a dial and a default.
     */
export async function adoptAgentDefaultPair(reg: AgentRegistry, entry: RegisteredAgentEntry, definition: AgentDefinition): Promise<string | undefined> {
        const origin = entry.store.modelSettingsOrigin();
        if (origin === "user") return undefined;
        const unresolvable = definition.defaultPair !== undefined
            && reg.wornAgentDefaultPair(entry) === undefined;
        const target = reg.effectiveDefaultPair(entry);
        if (
            entry.store.header.delegation !== undefined
            && !delegationAllows(entry.store.header.delegation, target)
        ) {
            return `${definition.name}'s default model is outside this delegated session's persisted boundary.`;
        }
        if (!samePair(target, entry.modelSettings)) {
            await entry.store.appendModelSettings(target, "agent-default");
            entry.modelSettings = target;
            entry.requestedReasoningEffort = undefined;
        }
        return unresolvable
            ? `${definition.name} names the pair ${definition.defaultPair!.name}, which is not in your pool. The session kept the host default.`
            : undefined;
    }

/**
     * Table 8.2: what a resumed session does about the agent it was wearing.
     *
     * Agents are by reference, so a definition that moved is worn as it is
     * now. The notice is what stops that from being a silent change of what
     * the session can reach.
     */
export async function reconcileResumedAgentWear(reg: AgentRegistry, entry: RegisteredAgentEntry, events: EngineEventBus): Promise<void> {
        const recorded = entry.agentWear;
        if (recorded === undefined) return;
        try {
            const catalog = await reg.agentCatalogFor(entry);
            const found = findCatalogAgent(catalog, recorded.name);
            if (found === undefined) {
                entry.agentWear = undefined;
                events.emit({
                    type: "agent_worn",
                    update: {
                        requestId: RESUME_WEAR_REQUEST_ID,
                        name: DEFAULT_AGENT.name,
                        notice:
                            `The agent ${recorded.name} is gone, so this session switched to default.`,
                    },
                });
                return;
            }
            const current = resolveAgentSnapshot(found.definition);
            entry.agentWear = current;
            const drift = agentSnapshotDrift(recorded, current);
            if (drift.length > 0) {
                events.emit({
                    type: "agent_worn",
                    update: {
                        requestId: RESUME_WEAR_REQUEST_ID,
                        name: current.name,
                        ...(current.tools === undefined
                            ? {}
                            : { tools: current.tools }),
                        ...(current.skills === undefined
                            ? {}
                            : { skills: current.skills }),
                        ...(current.posture === undefined
                            ? {}
                            : { posture: current.posture }),
                        notice: `${recorded.name} changed since it was selected: ${
                            drift.join(", ")
                        }.`,
                    },
                });
            }
        } catch {
            // A catalog that will not load leaves the recorded snapshot in
            // force, which is the scope the session already had.
        }
    }

/** The narrow writer: one key, one file, temp-and-rename. */
export async function updateAgentDefaultPairFor(reg: AgentRegistry, id: string, name: string, pair: { readonly name: string; readonly effort?: string } | null): Promise<string | undefined> {
        const entry = reg.agents.get(id);
        if (entry === undefined) return "No such session";
        const catalog = await reg.agentCatalogFor(entry);
        const found = findCatalogAgent(catalog, name);
        if (found === undefined) return `No agent named ${name}`;
        if (!found.writable || found.path === undefined) {
            return `${name} is registered by an extension, so its file cannot be written`;
        }
        try {
            await writeAgentDefaultPair(found.path, pair);
        } catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
        // The pair now IS the default, so the session record is reclassified
        // in the same operation rather than left showing an override.
        if (entry.agentWear?.name === name) {
            entry.agentWear = {
                ...entry.agentWear,
                ...(pair === null ? {} : { defaultPair: pair }),
            };
            if (pair === null) {
                const { defaultPair: _cleared, ...rest } = entry.agentWear;
                entry.agentWear = rest;
            }
            await entry.store.appendModelSettings(
                entry.modelSettings,
                reg.originFor(entry, entry.modelSettings),
            );
        }
        return undefined;
    }

export async function updateApprovalMode(reg: AgentRegistry, id: string, mode: ApprovalMode): Promise<ApprovalMode | undefined> {
        const result = await reg.applyApprovalMode(id, mode);
        reg.pushWorkerState(id);
        return result;
    }

export async function applyApprovalMode(reg: AgentRegistry, id: string, mode: ApprovalMode): Promise<ApprovalMode | undefined> {
        const entry = reg.agents.get(id);
        if (
            entry === undefined
            || entry.agent.closed
            || entry.agent.failed
            || !isApprovalMode(mode)
            || (
                builtInPermissionMode(mode) === undefined
                && reg.options.permissionModes?.[mode] === undefined
            )
        ) {
            return undefined;
        }
        await reg.leaveAgentThatForbidsAccess(entry, id, mode);
        await entry.store.appendApprovalMode(mode);
        reg.options.updateApprovalDefault?.(mode);
        reg.defaultApprovalMode = mode;
        entry.approvalMode = mode;
        return entry.approvalMode;
    }

/**
     * The posture a session ran under, for a spawn that has one to inherit.
     * `undefined` when the id names no session here, which is the cold case.
     */
export function approvalModeOf(reg: AgentRegistry, agentId: string): ApprovalMode | undefined {
        return reg.agents.get(agentId)?.approvalMode;
    }
