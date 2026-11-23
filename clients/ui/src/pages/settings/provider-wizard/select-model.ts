import { notifyProviderModelSelected } from "../../../models/provider-selection.ts";
import type { DesktopBridge } from "../../../protocol/bridge.ts";

export async function selectProviderModel(
    bridge: Pick<DesktopBridge, "selectProviderModel">,
    provider: string,
    model: string,
    current: () => boolean,
): ReturnType<DesktopBridge["selectProviderModel"]> {
    const result = await bridge.selectProviderModel(provider, model);
    if (result.ok && current()) notifyProviderModelSelected();
    return result;
}
