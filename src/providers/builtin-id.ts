import { shippedProviderIds } from "./definitions.ts";

export function isVeraProviderId(value: string): boolean {
    return shippedProviderIds().includes(value);
}
