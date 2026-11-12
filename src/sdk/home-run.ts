import { join } from "node:path";

import {
    loadOptionalVeraConfig,
    VERA_CONFIG_SCHEMA_VERSION,
    type VeraConfig,
} from "../config.ts";
import type { ModelAdapter } from "../model/types.ts";
import { createAuthStorage, type AuthStorage } from "../providers/auth-storage.ts";
import { createConfiguredModelAdapter } from "../providers/configured.ts";

export interface RunAdapterSession {
    readonly sessionId: string;
    readonly sessionPath: string;
}

export type RunAdapterFactory = (
    config: VeraConfig,
    workspace: string,
    session: RunAdapterSession,
) => ModelAdapter;

// Without config.json the agent names its own route, and posture stays readonly.
export function homeConfig(profileDirectory: string): VeraConfig {
    return loadOptionalVeraConfig({
        path: join(profileDirectory, "config.json"),
    }) ?? {
        schema_version: VERA_CONFIG_SCHEMA_VERSION,
        provider: "",
        model: "",
        approval_mode: "readonly",
    };
}

export function defaultRunAdapterFactory(): RunAdapterFactory {
    const authStorage = readOnlyAuthStorage(createAuthStorage());
    return (selected, selectedWorkspace) =>
        createConfiguredModelAdapter(selected, {
            authStorage,
            projectRoot: selectedWorkspace,
        });
}

function readOnlyAuthStorage(inner: AuthStorage): AuthStorage {
    return {
        getCredential: (provider) => inner.getCredential(provider),
        setCredential() {
            throw new Error(
                "This bounded run cannot write auth.json. Refresh the credential with vera login, then retry.",
            );
        },
        deleteCredential() {
            throw new Error(
                "This bounded run cannot write auth.json. Refresh the credential with vera login, then retry.",
            );
        },
    };
}
