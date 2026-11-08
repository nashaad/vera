import { join } from "node:path";

import type { ModelTurnSettings, OverrideSettingsPatch } from "../../engine/model-settings.ts";
import type { PermissionPredicate } from "../../engine/permissions.ts";
import type { ToolReviewerSettings } from "../../engine/reviewer.ts";
import type { LearnedFact, LearnedFacts, PoolFileModel } from "../../model/pool-file.ts";
import { addPoolModel, clearLearned, recordLearned } from "../../model/pool-file-store.ts";
import type { ApprovalMode } from "../../sdk/permissions.ts";
import type { SessionHost } from "../session-host.ts";
import { InboxAdmissionPolicy } from "../inbox-admission.ts";
import type { VeraConfig } from "../../config.ts";
import type { CredentialLease } from "./credentials.ts";

export type GlobalChange = "auth" | "config" | "pool" | "preferences" | "catalog";

export interface PoolCommit {
    readonly id: string;
    readonly declared: PoolFileModel;
    readonly learned?: LearnedFacts;
}

export function createMasterGlobals(options: {
    readonly master: SessionHost;
    readonly home: string;
    readonly lease: (provider: string, rejected?: string) => Promise<CredentialLease>;
    readonly changed: (kind: GlobalChange) => void;
    readonly config: () => VeraConfig;
    readonly configPath: string;
}) {
    const registry = options.master.registry;
    const poolPath = join(options.home, "pool.json");
    return {
        async handle(method: string, args: readonly unknown[]): Promise<unknown> {
            switch (method) {
                case "globals.credential":
                    if (typeof args[0] !== "string" || (args[1] !== undefined && typeof args[1] !== "string")) break;
                    return await options.lease(args[0], args[1]);
                case "globals.catalog":
                    return {
                        models: registry.modelsForClient(),
                        providerCatalogs: registry.options.providerCatalogs?.() ?? [],
                        refreshableProviders: registry.options.refreshableProviders?.() ?? [],
                    };
                case "globals.refreshCatalog": {
                    if (typeof args[0] !== "string") break;
                    const result = await registry.options.refreshCatalog?.(args[0]);
                    return result;
                }
                case "globals.modelDefaults":
                    await registry.options.updateModelDefaults?.(args[0] as ModelTurnSettings);
                    return;
                case "globals.contextLimit":
                    await registry.options.updateContextLimit?.(args[0] as number | null);
                    return;
                case "globals.approvalDefault":
                    await registry.options.updateApprovalDefault?.(args[0] as ApprovalMode);
                    return;
                case "globals.reviewer":
                    await registry.options.writeReviewer?.(args[0] as ToolReviewerSettings | null);
                    return;
                case "globals.overrides":
                    await registry.options.updateOverrides?.(args[0] as OverrideSettingsPatch);
                    return;
                case "globals.poolRemove":
                    await registry.options.removeFromPool?.(args[0] as { provider: string; model: string });
                    return;
                case "globals.poolName": {
                    const result = await registry.options.namePoolEntry?.(
                        args[0] as { provider: string; model: string }, args[1] as string | null, args[2] as string,
                    );
                    return result;
                }
                case "globals.poolMove": {
                    const result = await registry.options.movePoolEntry?.(
                        args[0] as { provider: string; model: string }, args[1] as number, args[2] as string,
                    );
                    return result;
                }
                case "globals.poolCommit": {
                    const commit = args[0] as PoolCommit;
                    addPoolModel(commit.id, commit.declared, { path: poolPath });
                    if (commit.learned !== undefined) {
                        clearLearned(commit.id, undefined, { path: poolPath });
                        recordLearned(commit.id, commit.learned, { path: poolPath });
                    }
                    options.changed("pool");
                    return;
                }
                case "globals.poolLearned": {
                    const [id, key, fact] = args as [string, string, LearnedFact];
                    recordLearned(id, { [key]: fact }, { path: poolPath });
                    options.changed("pool");
                    return;
                }
                case "globals.preferences":
                    return registry.options.permissionPreferences?.list() ?? [];
                case "globals.preferenceAdd": {
                    const preference = await registry.options.permissionPreferences?.add(args[0] as PermissionPredicate);
                    return preference;
                }
                case "globals.preferenceRemove": {
                    const removed = await registry.options.permissionPreferences?.remove(args[0] as string);
                    return removed;
                }
                case "globals.inboxRemember":
                    if (typeof args[0] !== "string") break;
                    await InboxAdmissionPolicy.fromConfig(options.config(), undefined, options.configPath).remember(args[0], "user");
                    options.changed("config");
                    return;
                case "globals.inboxRememberProject":
                    if (typeof args[0] !== "string" || typeof args[1] !== "string") break;
                    await InboxAdmissionPolicy.fromConfig(options.config(), args[1], options.configPath).remember(args[0], "project");
                    options.changed("config");
                    return;
            }
            throw new Error("Invalid host service request");
        },
    };
}
