/** Vera's side of running a local runtime: reading what it is doing, and starting, stopping and repointing it. The wizard puts one on the machine; this is everything after that. */

import { loadOptionalVeraConfig } from "../../../src/config.ts";
import { configuredProviders, type ProviderDescriptor } from "../../../src/providers/registry.ts";
import type { OutriderService } from "../../../src/providers/outrider.ts";
import { localRuntimeActivity } from "../local-runtime-status.ts";
import type { TuiLocalRuntimeAction, TuiLocalRuntimeStatus } from "../settings-picker-types.ts";
import { showStatusNotice } from "./notices.ts";
import { appendTuiError, appendTuiNotice } from "../state.ts";
import {
    defaultOutriderDriver,
    outriderBinary,
    outriderLogs,
    outriderService,
    serveOutrider,
    startOutrider,
    stopOutrider,
    useOutriderProfile,
    type OutriderDriver,
} from "./outrider-ops.ts";
import type { OutriderProgress } from "../../../src/providers/outrider.ts";
import { renderState } from "./render-state.ts";
import type { TuiRuntime } from "./runtime.ts";

/** The driver this runtime uses, so a test can hand Vera an Outrider that is not on the machine. */
function driverOf(rt: TuiRuntime): OutriderDriver {
    return rt.dependencies?.outrider ?? defaultOutriderDriver;
}

/** How often the line is put back while a command runs. The status area clears itself after a moment, and a load that reports no bytes would otherwise go quiet for as long as it takes. */
const NOTICE_HEARTBEAT_MS = 1_000;

/** How many log lines the Logs action shows. Enough to carry a failure, short enough to read. */
const LOG_TAIL_LINES = 12;

/** The provider a runtime on this machine serves, if this build has one. Vera drives one local runtime, so the first is the only. */
export function localRuntimeProvider(
    config = loadOptionalVeraConfig(),
): ProviderDescriptor | undefined {
    return configuredProviders(config)
        .find((provider) => provider.localRuntime !== undefined);
}

/** What `status` said, as the provider screen's facts. The gateway and the model move independently, so both are read and the model decides whether anything is being served. */
export function localRuntimeStatusOf(
    provider: ProviderDescriptor,
    service: OutriderService | undefined,
): TuiLocalRuntimeStatus {
    const base = { provider: provider.id, label: provider.label } as const;
    if (service === undefined) return { ...base, state: "absent" };
    const gateway = service.gateway.kind === "running" ? "up" : "down";
    const serving = service.model.kind === "running";
    if (!serving) return { ...base, state: "stopped", gateway };
    return {
        ...base,
        state: "running",
        gateway,
        ...(service.model.profile === undefined
            ? {}
            : { profile: service.model.profile }),
        ...(service.gateway.endpoint === undefined
            ? {}
            : { endpoint: service.gateway.endpoint }),
        ...(service.model.healthy === undefined
            ? {}
            : { healthy: service.model.healthy }),
        ...(service.model.residentBytes === undefined
            ? {}
            : { residentBytes: service.model.residentBytes }),
    };
}

/** Hold the reading, and put it in front of the user if the screen that shows it is open. */
export function applyLocalRuntimeStatus(
    rt: TuiRuntime,
    status: TuiLocalRuntimeStatus,
): void {
    rt.localRuntime = status;
    const picker = rt.settingsPicker;
    if (picker?.kind === "provider") {
        rt.settingsPicker = { ...picker, localRuntime: status };
    }
    renderState(rt);
}

/** Ask the runtime what it is doing. Safe on every open: nothing here starts anything. */
export async function refreshLocalRuntimeStatus(
    rt: TuiRuntime,
    driver: OutriderDriver = driverOf(rt),
): Promise<void> {
    const provider = localRuntimeProvider();
    if (provider === undefined) return;
    if (rt.localRuntime === undefined) {
        applyLocalRuntimeStatus(rt, {
            provider: provider.id,
            label: provider.label,
            state: "unknown",
        });
    }
    const service = driver.binary() === undefined
        ? undefined
        : await outriderService(driver);
    // A command Vera started since this reading went out owns the section.
    if (rt.localRuntimeCommand !== undefined) return;
    applyLocalRuntimeStatus(rt, localRuntimeStatusOf(provider, service));
}

/** The profile a start should bring up: the one Vera is pointed at, when that model is this runtime's. Otherwise the runtime decides, which is its last one. */
export function profileToStart(
    provider: ProviderDescriptor,
    config = loadOptionalVeraConfig(),
): string | undefined {
    return config?.provider === provider.id ? config.model : undefined;
}

function busy(
    rt: TuiRuntime,
    provider: ProviderDescriptor,
    state: NonNullable<TuiLocalRuntimeStatus["busy"]>,
): TuiLocalRuntimeStatus {
    const { failure: _cleared, progress: _stale, ...held } = rt.localRuntime
        ?? { provider: provider.id, label: provider.label, state: "unknown" as const };
    const started = { ...held, busy: state };
    applyLocalRuntimeStatus(rt, started);
    return started;
}

/** Say what the runtime is doing where the user actually is. The provider screen carries the section already, so a notice there would say it twice. */
function announce(rt: TuiRuntime, status: TuiLocalRuntimeStatus): void {
    if (rt.settingsPicker?.kind === "provider") return;
    const line = localRuntimeActivity(status);
    if (rt.localRuntimeNotice === line) return;
    rt.localRuntimeNotice = line;
    showStatusNotice(rt, line);
}

/** The last word on a command, and the end of the running commentary. Silent unless something was said while it ran. */
function settle(rt: TuiRuntime, status: TuiLocalRuntimeStatus): void {
    if (rt.localRuntimeNotice === undefined) return;
    rt.localRuntimeNotice = undefined;
    if (rt.settingsPicker?.kind === "provider") return;
    showStatusNotice(rt, status.failure ?? localRuntimeActivity(status));
}

/** A fetch reports bytes as it goes; bringing weights already on disk into memory reports none. A finished piece stops being news, so it leaves the line. */
function trackProgress(
    rt: TuiRuntime,
    state: NonNullable<TuiLocalRuntimeStatus["busy"]>,
    line: OutriderProgress,
): void {
    const held = rt.localRuntime;
    if (held?.busy !== state) return;
    const { progress: _previous, ...rest } = held;
    const next = line.done || line.total === undefined
        ? rest
        : {
            ...rest,
            progress: {
                downloaded: line.downloaded ?? 0,
                total: line.total,
                ...(line.etaSeconds === undefined ? {} : { etaSeconds: line.etaSeconds }),
            },
        };
    applyLocalRuntimeStatus(rt, next);
    announce(rt, next);
}

/** Run one lifecycle command and settle the section on what it left behind. A failure is shown in the section rather than as a notice, because the section is what the user is looking at. */
async function drive(
    rt: TuiRuntime,
    provider: ProviderDescriptor,
    state: NonNullable<TuiLocalRuntimeStatus["busy"]>,
    said: string,
    start: (
        onProgress: (line: OutriderProgress) => void,
    ) => { readonly finished: Promise<{ readonly ok: boolean; readonly detail: string }>; stop(): void },
    driver: OutriderDriver,
): Promise<void> {
    if (rt.localRuntimeCommand !== undefined) return;
    announce(rt, busy(rt, provider, state));
    const command = start((line) => { trackProgress(rt, state, line); });
    rt.localRuntimeCommand = command;
    const beat = setInterval(() => {
        if (rt.localRuntime?.busy !== state || rt.localRuntimeNotice === undefined) return;
        showStatusNotice(rt, rt.localRuntimeNotice);
    }, NOTICE_HEARTBEAT_MS);
    beat.unref?.();
    const result = await command.finished;
    clearInterval(beat);
    rt.localRuntimeCommand = undefined;
    if (!result.ok) {
        const service = driver.binary() === undefined
            ? undefined
            : await outriderService(driver);
        const failed = {
            ...localRuntimeStatusOf(provider, service),
            failure: `${said}${result.detail === "" ? "" : `: ${result.detail}`}`,
        };
        applyLocalRuntimeStatus(rt, failed);
        settle(rt, failed);
        return;
    }
    await refreshLocalRuntimeStatus(rt, driver);
    if (rt.localRuntime !== undefined) settle(rt, rt.localRuntime);
}

/** Stop the runtime if anything is up, then run what comes next. Restart is the only caller, and it must not start before the stop has landed. */
function afterStop(
    rt: TuiRuntime,
    driver: OutriderDriver,
    next: () => void,
): void {
    const command = stopOutrider(() => {}, driver);
    rt.localRuntimeCommand = command;
    void command.finished.then(() => {
        rt.localRuntimeCommand = undefined;
        next();
    });
}

function startCommand(
    rt: TuiRuntime,
    provider: ProviderDescriptor,
    driver: OutriderDriver,
): void {
    const profile = profileToStart(provider);
    void drive(
        rt,
        provider,
        "starting",
        "could not start",
        (onProgress) => profile === undefined
            ? startOutrider(onProgress, driver)
            : serveOutrider(profile, onProgress, driver),
        driver,
    );
}

/** What the provider screen asked for. `switch` is the one that leaves this module, because choosing a profile is a screen of its own. */
export function runLocalRuntimeAction(
    rt: TuiRuntime,
    action: TuiLocalRuntimeAction,
    onSwitch: (provider: string) => void,
    driver: OutriderDriver = driverOf(rt),
): void {
    const provider = localRuntimeProvider();
    if (provider === undefined) return;
    if (driver === defaultOutriderDriver && outriderBinary() === undefined) {
        rt.state = appendTuiError(rt.state, `${provider.label} is not installed`);
        renderState(rt);
        return;
    }
    if (action === "switch") {
        onSwitch(provider.id);
        return;
    }
    if (action === "logs") {
        void showLocalRuntimeLogs(rt, provider, driver);
        return;
    }
    if (rt.localRuntimeCommand !== undefined) return;
    if (action === "start") {
        startCommand(rt, provider, driver);
        return;
    }
    if (action === "stop") {
        void drive(rt, provider, "stopping", "could not stop", (onProgress) => stopOutrider(onProgress, driver), driver);
        return;
    }
    busy(rt, provider, "starting");
    afterStop(rt, driver, () => { startCommand(rt, provider, driver); });
}

/** Point a running gateway at another profile, or bring one up on it when nothing is running. `use` needs a gateway; `serve` is what makes one. */
export function switchLocalRuntimeProfile(
    rt: TuiRuntime,
    profile: string,
    driver: OutriderDriver = driverOf(rt),
): void {
    const provider = localRuntimeProvider();
    if (provider === undefined) return;
    const running = rt.localRuntime?.gateway === "up";
    void drive(
        rt,
        provider,
        "switching",
        `could not switch to ${profile}`,
        (onProgress) => running
            ? useOutriderProfile(profile, onProgress, driver)
            : serveOutrider(profile, onProgress, driver),
        driver,
    );
}

/** Bring the runtime to this profile and wait for it. A probe answers from whatever the gateway has loaded, so verifying a profile that is not loaded would report on the wrong model. */
export async function ensureLocalRuntimeProfile(
    rt: TuiRuntime,
    profile: string,
    driver: OutriderDriver = driverOf(rt),
): Promise<void> {
    const provider = localRuntimeProvider();
    if (provider === undefined || driver.binary() === undefined) return;
    const service = await outriderService(driver);
    if (service?.model.kind === "running" && service.model.profile === profile) {
        applyLocalRuntimeStatus(rt, localRuntimeStatusOf(provider, service));
        return;
    }
    await drive(
        rt,
        provider,
        "switching",
        `could not switch to ${profile}`,
        (onProgress) => serveOutrider(profile, onProgress, driver),
        driver,
    );
}

async function showLocalRuntimeLogs(
    rt: TuiRuntime,
    provider: ProviderDescriptor,
    driver: OutriderDriver,
): Promise<void> {
    const tail = await outriderLogs(LOG_TAIL_LINES, driver);
    if (tail.lines.length === 0) {
        rt.state = appendTuiNotice(
            rt.state,
            tail.detail ?? `${provider.label} has written no log yet`,
        );
        renderState(rt);
        return;
    }
    rt.state = appendTuiNotice(
        rt.state,
        [`${provider.label} log`, ...tail.lines].join("\n"),
    );
    renderState(rt);
}
