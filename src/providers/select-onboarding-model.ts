import { updateVeraConfigDefaults } from "../config.ts";
import type { ModelOperationResult } from "../model/model-operations.ts";
import { setPoolMembership } from "../model/pool-file-store.ts";

export interface SelectOnboardingModelOptions {
    readonly provider: string;
    readonly model: string;
    readonly configPath: string;
    readonly poolPath: string;
    readonly verify: () => Promise<ModelOperationResult | undefined>;
}

export async function selectOnboardingModel(options: SelectOnboardingModelOptions): Promise<void> {
    const result = await options.verify();
    if (result?.status !== "passed" || result.provider !== options.provider || result.model !== options.model) {
        throw new Error(result?.reason ?? "The model did not answer");
    }
    setPoolMembership([`${options.provider}/${options.model}`], true, { path: options.poolPath });
    updateVeraConfigDefaults({ provider: options.provider, model: options.model, reasoning_effort: null }, { path: options.configPath });
}
