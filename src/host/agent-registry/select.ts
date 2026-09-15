import { findCatalogAgent, loadAgentCatalog, type AgentCatalog } from "../../agents/catalog.ts";
import { DEFAULT_AGENT, type AgentDefinition } from "../../agents/definition.ts";
import { agentSnapshotDrift, resolveAgentSnapshot } from "../../agents/snapshot.ts";
import { writeAgentDefaultPair } from "../../agents/writer.ts";
import { EngineEventBus } from "../../engine/events.ts";
import type { ModelTurnSettings } from "../../engine/model-settings.ts";
import { PermissionModeSyncError } from "../../engine/inbound-command-router.ts";
import { BUILT_IN_PERMISSION_MODE_NAMES, builtInPermissionMode, isApprovalMode, type ApprovalMode } from "../../engine/permissions.ts";
import { decideSkillInvocation, loadSkillCommandCatalog, type SkillCommandCatalog, type SkillInvocationDecision } from "../../skills/commands.ts";
import { sessionIsSubagent } from "../../store/session-store.ts";
import { delegationAllows } from "./helpers.ts";
import { RESUME_SELECT_REQUEST_ID, resolveInstructionRoot, samePair, type RegisteredAgentEntry } from "./support.ts";
import type { AgentRegistry } from "../agent-registry.ts";

function syncWorkerAfterPermissionChange(
    reg: AgentRegistry,
    id: string,
    mode: ApprovalMode | undefined,
): ApprovalMode | undefined {
    try {
        reg.pushWorkerState(id);
    } catch (error) {
        if (mode !== undefined) {
            throw new PermissionModeSyncError(mode, error);
        }
        throw error;
    }
    return mode;
}

export async function updateSessionPermissionMode(reg: AgentRegistry, id: string, mode: ApprovalMode): Promise<ApprovalMode | undefined> {
        const result = await reg.applySessionPermissionMode(id, mode);
        return syncWorkerAfterPermissionChange(reg, id, result);
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
            mode === reg.selectedAgentPosture(entry) ? "agent-default" : "user",
        );
        entry.approvalMode = mode;
        return entry.approvalMode;
    }

export async function leaveAgentThatForbidsAccess(reg: AgentRegistry, entry: RegisteredAgentEntry, id: string, mode: ApprovalMode): Promise<void> {
        const active = entry.selectedAgent;
        if (active?.forbiddenAccess?.includes(mode) !== true) return;
        const switched = await reg.selectAgentFor(id, DEFAULT_AGENT.name);
        if (switched === undefined) return;
        entry.events.emit({
            type: "agent_selected",
            update: {
                requestId: `permissions-${mode}`,
                ...switched,
                notice:
                    `Switched to default because ${active.name} does not allow ${mode.replaceAll("_", " ")} access.`,
            },
        });
    }

export function selectedAgentDefaultPair(reg: AgentRegistry, entry: RegisteredAgentEntry): ModelTurnSettings | undefined {
        const pair = entry.selectedAgent?.defaultPair;
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

export function selectedAgentPosture(reg: AgentRegistry, entry: RegisteredAgentEntry): ApprovalMode | undefined {
        const named = entry.selectedAgent?.posture;
        return named !== undefined && isApprovalMode(named)
            ? named
            : reg.defaultApprovalMode;
    }

export async function listAgentsFor(reg: AgentRegistry, id: string): Promise<{
        readonly selected: string;
        readonly agents: readonly {
            readonly name: string;
            readonly description?: string;
            readonly scope: "project" | "user" | "extension";
            readonly writable: boolean;
            readonly tools?: readonly string[];
            readonly skills?: readonly string[];
            readonly posture?: string;
            readonly forbiddenAccess?: readonly string[];
            readonly subagentAssignment?: string;
            readonly defaultPair?: {
                readonly name: string;
                readonly effort?: string;
            };
        }[];
        readonly notices: readonly string[];
    }> {
        const entry = reg.agents.get(id);
        if (entry === undefined) {
            return { selected: DEFAULT_AGENT.name, agents: [], notices: [] };
        }
        const catalog = await reg.agentCatalogFor(entry);
        return {
            selected: entry.selectedAgent?.name ?? DEFAULT_AGENT.name,
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
                ...(agent.definition.subagentAssignment === undefined ? {} : {
                    subagentAssignment: agent.definition.subagentAssignment,
                }),
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
            ...(entry.selectedAgent?.skills === undefined
                ? {}
                : { allowedSkills: entry.selectedAgent.skills }),
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
            ...(entry.selectedAgent?.skills === undefined
                ? {}
                : { allowedSkills: entry.selectedAgent.skills }),
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

export async function selectAgentFor(reg: AgentRegistry, id: string, name: string): Promise<{
        readonly name: string;
        readonly tools?: readonly string[];
        readonly skills?: readonly string[];
        readonly posture?: string;
        readonly forbiddenAccess?: readonly string[];
        readonly notice?: string;
        readonly permissionChanged?: boolean;
    } | undefined> {
        const result = await reg.applySelectedAgent(id, name);
        reg.pushWorkerState(id);
        return result;
    }

export async function applySelectedAgent(reg: AgentRegistry, id: string, name: string): Promise<{
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
        await entry.store.appendSelectedAgent(snapshot.name, snapshot);
        entry.selectedAgent = snapshot;
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

export async function adoptAgentDefaultPair(reg: AgentRegistry, entry: RegisteredAgentEntry, definition: AgentDefinition): Promise<string | undefined> {
        const origin = entry.store.modelSettingsOrigin();
        if (origin === "user") return undefined;
        const unresolvable = definition.defaultPair !== undefined
            && reg.selectedAgentDefaultPair(entry) === undefined;
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

export async function reconcileResumedSelectedAgent(reg: AgentRegistry, entry: RegisteredAgentEntry, events: EngineEventBus): Promise<void> {
        const recorded = entry.selectedAgent;
        if (recorded === undefined) return;
        try {
            const catalog = await reg.agentCatalogFor(entry);
            const found = findCatalogAgent(catalog, recorded.name);
            if (found === undefined) {
                entry.selectedAgent = undefined;
                events.emit({
                    type: "agent_selected",
                    update: {
                        requestId: RESUME_SELECT_REQUEST_ID,
                        name: DEFAULT_AGENT.name,
                        notice:
                            `The agent ${recorded.name} is gone, so this session switched to default.`,
                    },
                });
                return;
            }
            const current = resolveAgentSnapshot(found.definition);
            entry.selectedAgent = current;
            const drift = agentSnapshotDrift(recorded, current);
            if (drift.length > 0) {
                events.emit({
                    type: "agent_selected",
                    update: {
                        requestId: RESUME_SELECT_REQUEST_ID,
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
        }
    }

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
        if (entry.selectedAgent?.name === name) {
            entry.selectedAgent = {
                ...entry.selectedAgent,
                ...(pair === null ? {} : { defaultPair: pair }),
            };
            if (pair === null) {
                const { defaultPair: _cleared, ...rest } = entry.selectedAgent;
                entry.selectedAgent = rest;
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
        return syncWorkerAfterPermissionChange(reg, id, result);
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

export function approvalModeOf(reg: AgentRegistry, agentId: string): ApprovalMode | undefined {
        return reg.agents.get(agentId)?.approvalMode;
    }
