export interface SubscriptionUsageWindow {
    readonly windowMinutes: number;
    readonly usedPercent: number;
    readonly resetsAt: number;
}

export interface SubscriptionLimits {
    readonly provider: string;
    readonly fetchedAt: number;
    readonly windows: readonly SubscriptionUsageWindow[];
}
