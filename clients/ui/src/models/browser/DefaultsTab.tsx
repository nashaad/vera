import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { ArrowUpIcon, ChevronDownIcon, PlusIcon, XIcon } from "../../components/Icons.tsx";
import { usePopoverPlacement } from "../../components/usePopoverPlacement.ts";
import { showToast } from "../../overlays/toasts.ts";
import {
    slotOf,
    TIER_IDS,
    type AssignedModel,
    type AssignmentChange,
    type AssignmentSlot,
    type AssignmentsView,
} from "../../protocol/assignments.ts";
import type { DesktopBridge } from "../../protocol/bridge.ts";
import { findModel, shortModelName } from "../catalog.ts";
import type { ModelControls } from "../controls.ts";
import { levelLabel, providerLabel } from "../menuRows.ts";
import type { ModelSettings } from "../settings.ts";
import {
    allText,
    assignedText,
    changedSlots,
    currentOf,
    failsafeOf,
    failsafeText,
    PICKER_TITLE,
    SLOT_COPY,
    subagentAddedText,
    unreachable,
    unsetChoice,
    usedByText,
    type PickTarget,
    type SingleSlot,
} from "./defaults.ts";
import { entryKey } from "./rows.ts";
import { SlotPicker } from "./SlotPicker.tsx";

export interface DefaultsTabProps {
    readonly controls: ModelControls;
    readonly settings: ModelSettings;
}

// The models background work runs on, read from and written to the home's config.json.
export function DefaultsTab({ controls, settings }: DefaultsTabProps) {
    const bridge = window.veraDesktop as DesktopBridge | undefined;
    const [view, setView] = useState<AssignmentsView | undefined>(undefined);
    const [problem, setProblem] = useState<string | undefined>(
        bridge === undefined ? "Defaults are set in the desktop app or the terminal." : undefined,
    );
    const [picking, setPicking] = useState<PickTarget | undefined>(undefined);
    const close = useCallback(() => setPicking(undefined), []);

    useEffect(() => {
        if (bridge === undefined) return undefined;
        let live = true;
        void bridge.readAssignments().then((result) => {
            if (!live) return;
            if (result.ok) setView(result);
            else setProblem(result.reason);
        });
        return () => {
            live = false;
        };
    }, [bridge]);

    const name = (model: AssignedModel): string => shortModelName(settings, model);
    const effortWord = (model: AssignedModel): string | undefined => {
        if (model.effort === undefined) return undefined;
        const entry = findModel(settings, model);
        return `${levelLabel(entry?.levels ?? [], model.effort).toLowerCase()} effort`;
    };

    const write = async (change: AssignmentChange): Promise<AssignmentsView | undefined> => {
        if (bridge === undefined) return undefined;
        const result = await bridge.editAssignment(change);
        if (!result.ok) {
            showToast(result.reason, "danger");
            return undefined;
        }
        setView(result.view);
        return result.view;
    };

    // Subagents run only favorites and an agent can run on any assignment, so an assigned model joins them.
    const keep = async (model: AssignedModel, said: string): Promise<void> => {
        const reason = await controls.actions.shortlist({ provider: model.provider, model: model.model }, true);
        if (reason === undefined) {
            showToast(`${said}, and it is now a favorite`, "success");
            return;
        }
        showToast(said, "success");
        showToast(`${name(model)} is assigned but not in your favorites, so subagents cannot use it yet: ${reason}`, "warning");
    };

    const apply = async (target: PickTarget, value: AssignedModel | undefined): Promise<void> => {
        setPicking(undefined);
        if (bridge === undefined) return;
        const before = view;
        let said: string;
        let favorite: boolean;
        if (target === "all") {
            if (value === undefined) return;
            const result = await bridge.assignToAll(value.provider, value.model);
            if (!result.ok) {
                showToast(result.reason, "danger");
                return;
            }
            setView(result.view);
            if (result.failure !== undefined) showToast(result.failure, "warning");
            said = allText(changedSlots(before, result.view), value, name);
            favorite = result.favorite;
        } else {
            const change = changeOf(target, value);
            if (change === undefined) return;
            const result = await bridge.editAssignment(change);
            if (!result.ok) {
                showToast(result.reason, "danger");
                return;
            }
            setView(result.view);
            favorite = result.favorite;
            said = target === "failsafe"
                ? failsafeText(value, name)
                : target === "subagent"
                ? subagentAddedText(value!, slotOf(result.view, "subagents")?.declared.length ?? 1, name)
                : assignedText(target, value, name, value === undefined ? undefined : effortWord(value));
        }
        if (favorite && value !== undefined) await keep(value, said);
        else showToast(said, "success");
    };

    const control = (target: PickTarget, label: ReactNode, unset: boolean, add = false) => (
        <SlotControl
            open={picking === target}
            label={label}
            unset={unset}
            add={add}
            onOpen={() => setPicking(picking === target ? undefined : target)}
            onClose={close}
            picker={(style) => (
                <SlotPicker
                    title={PICKER_TITLE[target]}
                    settings={settings}
                    current={currentOf(view, target)}
                    exclude={target === "subagent" ? new Set(slotOf(view, "subagents")?.declared.map(entryKey)) : new Set()}
                    unset={unsetChoice(view, target, name)}
                    withEffort={target !== "all"}
                    style={style}
                    onPick={(value) => void apply(target, value)}
                />
            )}
        />
    );

    const single = (id: SingleSlot) => {
        const slot = slotOf(view, id);
        return control(id, <SlotValue slot={slot} settings={settings} name={name} />, slot?.bound !== true);
    };

    const reviewer = slotOf(view, "reviewer");
    const subagents = slotOf(view, "subagents");
    const listed = subagents?.declared ?? [];
    const failsafe = failsafeOf(view);

    return (
        <div className="models-plain defaults" onScroll={close}>
            {problem === undefined ? null : <p className="defaults-notice">{problem}</p>}
            {view?.notice === undefined ? null : <p className="defaults-notice">{view.notice}</p>}
            {view === undefined ? null : (
                <>
                    <div className="defaults-group">
                        Tiers <span>Features ask for one of these by name.</span>
                    </div>
                    {TIER_IDS.map((tier) => (
                        <SlotRow key={tier} name={SLOT_COPY[tier].name} about={SLOT_COPY[tier].about} more={usedByText(view, tier)}>
                            {single(tier)}
                        </SlotRow>
                    ))}

                    <div className="defaults-group">
                        Dedicated jobs <span>Each uses its tier while not set.</span>
                    </div>
                    <SlotRow name={SLOT_COPY.reviewer.name} about={SLOT_COPY.reviewer.about}>
                        {single("reviewer")}
                    </SlotRow>
                    {reviewer?.bound === true ? (
                        <SlotRow name="Failsafe" about="Answers when the classifier errors or cannot be reached." sub>
                            {control(
                                "failsafe",
                                failsafe === undefined ? "None" : <ModelValue model={failsafe} settings={settings} name={name} />,
                                failsafe === undefined,
                            )}
                        </SlotRow>
                    ) : null}
                    <SlotRow name={SLOT_COPY.compaction.name} about={SLOT_COPY.compaction.about}>
                        {single("compaction")}
                    </SlotRow>
                    <SlotRow name="Subagents" about="Delegated work. Vera tries each model in order and says when it substitutes.">
                        {control(
                            "subagent",
                            <>
                                <PlusIcon className="slot-btn-icon" />
                                Add a model
                            </>,
                            false,
                            true,
                        )}
                    </SlotRow>
                    <ol className="sub-list" aria-label="Subagent models, in the order Vera tries them">
                        {listed.map((model, index) => (
                            <li key={entryKey(model)}>
                                <span className="sub-n">{index + 1}</span>
                                <span className="sub-name">
                                    {name(model)} <span className="sub-dim">{providerLabel(settings, model.provider)}</span>
                                </span>
                                {model.effort === undefined ? null : (
                                    <span className="sub-dim">{levelLabel(findModel(settings, model)?.levels ?? [], model.effort)}</span>
                                )}
                                <span className="sub-actions">
                                    <button
                                        type="button"
                                        title="Try earlier"
                                        aria-label={`Try ${name(model)} earlier`}
                                        disabled={index === 0}
                                        onClick={() => void write({ assignment: "subagents", provider: model.provider, model: model.model, move: -1 })}
                                    >
                                        <ArrowUpIcon />
                                    </button>
                                    <button
                                        type="button"
                                        title="Try later"
                                        aria-label={`Try ${name(model)} later`}
                                        disabled={index === listed.length - 1}
                                        onClick={() => void write({ assignment: "subagents", provider: model.provider, model: model.model, move: 1 })}
                                    >
                                        <ArrowUpIcon className="sub-down" />
                                    </button>
                                    <button
                                        type="button"
                                        title="Remove"
                                        aria-label={`Remove ${name(model)}`}
                                        onClick={() => void write({ assignment: "subagents", provider: model.provider, model: model.model, remove: true })}
                                    >
                                        <XIcon />
                                    </button>
                                </span>
                            </li>
                        ))}
                        {listed.length === 0 ? (
                            <li className="sub-empty">
                                {subagents?.allowSelf === true
                                    ? "No models assigned. Subagents run on the spawning session's model."
                                    : "No models assigned. A delegated task asks you to pick one first."}
                            </li>
                        ) : null}
                    </ol>
                    <SlotRow name="Then the spawning session's model" about="Tried after every model above. Off by default." sub>
                        <button
                            type="button"
                            role="switch"
                            className="appearance-switch"
                            aria-checked={subagents?.allowSelf === true}
                            aria-label="Then the spawning session's model"
                            onClick={() => void write({ assignment: "subagents", allowSelf: subagents?.allowSelf !== true })}
                        >
                            <span className="appearance-switch-knob" />
                        </button>
                    </SlotRow>

                    <div className="defaults-all">
                        <SlotRow name="Assign one model to all" about="Subagents try it first and keep the rest of their list. The failsafe stays.">
                            {control("all", "Choose a model", false)}
                        </SlotRow>
                    </div>
                </>
            )}
        </div>
    );
}

function changeOf(target: Exclude<PickTarget, "all">, value: AssignedModel | undefined): AssignmentChange | undefined {
    const model = value === undefined
        ? {}
        : { provider: value.provider, model: value.model, ...(value.effort === undefined ? {} : { effort: value.effort }) };
    if (target === "failsafe") return { assignment: "reviewer", failsafe: true, ...model };
    if (target === "subagent") return value === undefined ? undefined : { assignment: "subagents", ...model };
    return { assignment: target, ...model };
}

interface SlotRowProps {
    readonly name: string;
    readonly about: string;
    readonly more?: string;
    readonly sub?: boolean;
    readonly children: ReactNode;
}

function SlotRow({ name, about, more, sub = false, children }: SlotRowProps) {
    return (
        <div className="slot-row" data-sub={sub}>
            <div className="slot-row-body">
                <div className="slot-row-name">{name}</div>
                <div className="slot-row-about">
                    {about}
                    {more === undefined ? null : <span className="slot-row-more"> {more}</span>}
                </div>
            </div>
            {children}
        </div>
    );
}

interface SlotControlProps {
    readonly open: boolean;
    readonly label: ReactNode;
    readonly unset: boolean;
    readonly add: boolean;
    readonly onOpen: () => void;
    readonly onClose: () => void;
    readonly picker: (style: ReturnType<typeof usePopoverPlacement>) => ReactNode;
}

function SlotControl({ open, label, unset, add, onOpen, onClose, picker }: SlotControlProps) {
    const root = useRef<HTMLDivElement>(null);
    const button = useRef<HTMLButtonElement>(null);
    const placed = usePopoverPlacement(open, root);

    useEffect(() => {
        if (!open) return undefined;
        const onPointer = (event: MouseEvent): void => {
            if (root.current !== null && event.target instanceof Node && !root.current.contains(event.target)) onClose();
        };
        // Captured on the window so the Models sheet's own Escape does not also close the sheet.
        const onKey = (event: KeyboardEvent): void => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            event.preventDefault();
            onClose();
            button.current?.focus({ preventScroll: true });
        };
        document.addEventListener("mousedown", onPointer);
        window.addEventListener("keydown", onKey, true);
        return () => {
            document.removeEventListener("mousedown", onPointer);
            window.removeEventListener("keydown", onKey, true);
        };
    }, [open, onClose]);

    return (
        <div className="slot-anchor" ref={root}>
            <button
                ref={button}
                type="button"
                className="slot-btn"
                data-unset={unset}
                data-add={add}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={onOpen}
            >
                <span className="slot-btn-label">{label}</span>
                {add ? null : <ChevronDownIcon className="slot-btn-icon" />}
            </button>
            {open ? picker(placed) : null}
        </div>
    );
}

interface ModelValueProps {
    readonly model: AssignedModel;
    readonly settings: ModelSettings;
    readonly name: (model: AssignedModel) => string;
}

function ModelValue({ model, settings, name }: ModelValueProps) {
    const entry = findModel(settings, model);
    return (
        <span title={`${entry?.label ?? model.model} · ${providerLabel(settings, model.provider)}`}>
            {name(model)}
            {model.effort === undefined ? null : <span className="slot-dim"> {levelLabel(entry?.levels ?? [], model.effort)}</span>}
        </span>
    );
}

interface SlotValueProps {
    readonly slot: AssignmentSlot | undefined;
    readonly settings: ModelSettings;
    readonly name: (model: AssignedModel) => string;
}

// A set slot shows its model; an unset job shows the tier it runs on, or the session model past that.
function SlotValue({ slot, settings, name }: SlotValueProps) {
    if (slot === undefined) return "Not set";
    const first = slot.bound ? slot.declared[0] : undefined;
    if (first !== undefined) {
        return (
            <>
                {unreachable(slot) ? <span className="slot-tag" title="Its provider is not connected or does not list it">Cannot run</span> : null}
                <ModelValue model={first} settings={settings} name={name} />
            </>
        );
    }
    if (slot.bound && slot.route !== undefined) return slot.route;
    if (slot.inherits !== undefined && slot.source === "intent" && slot.running[0] !== undefined) {
        return (
            <>
                <span className="slot-tag">Uses {SLOT_COPY[slot.inherits].name}</span>
                {name(slot.running[0])}
            </>
        );
    }
    if (slot.id === "reviewer" || slot.id === "compaction") {
        return (
            <>
                <span className="slot-tag">Not set</span>
                Session model
            </>
        );
    }
    return "Not set";
}
