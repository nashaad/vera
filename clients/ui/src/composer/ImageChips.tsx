import { ImageIcon, XIcon } from "../components/Icons.tsx";

export interface ImageChip {
    readonly key: string;
    readonly label: string;
    readonly name: string;
    readonly attaching: boolean;
}

export interface ImageChipsProps {
    readonly chips: readonly ImageChip[];
    readonly onRemove: (key: string) => void;
}

export function ImageChips({ chips, onRemove }: ImageChipsProps) {
    if (chips.length === 0) return null;
    return (
        <div className="context-chips attached">
            {chips.map((chip) => (
                <span className="chip chip-file" key={chip.key} title={chip.name} data-attaching={chip.attaching}>
                    <ImageIcon className="chip-icon" />
                    <span className="chip-label">{chip.attaching ? `${chip.label}, attaching` : chip.label}</span>
                    <button
                        type="button"
                        className="chip-x"
                        title={`Remove ${chip.label}`}
                        aria-label={`Remove ${chip.label}`}
                        onClick={() => onRemove(chip.key)}
                    >
                        <XIcon className="chip-x-icon" />
                    </button>
                </span>
            ))}
        </div>
    );
}
