interface HookDeadlinePolicy {
    readonly onFailure: "allow" | "deny";
    readonly blockReason: (failure: string) => string;
}

const policies = new WeakMap<object, HookDeadlinePolicy>();

export function setHookDeadlinePolicy(hook: object, policy: HookDeadlinePolicy): void {
    policies.set(hook, policy);
}

export function getHookDeadlinePolicy(hook: object): HookDeadlinePolicy | undefined {
    return policies.get(hook);
}
