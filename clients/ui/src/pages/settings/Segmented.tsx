export interface SegmentedProps<T extends string> {
    readonly label: string;
    readonly options: readonly T[];
    readonly labels: Readonly<Record<T, string>>;
    readonly value: T;
    readonly onChange: (value: T) => void;
}

export function Segmented<T extends string>({ label, options, labels, value, onChange }: SegmentedProps<T>) {
    return (
        <div className="appearance-seg" role="group" aria-label={label}>
            {options.map((option) => (
                <button key={option} type="button" aria-pressed={option === value} onClick={() => onChange(option)}>
                    {labels[option]}
                </button>
            ))}
        </div>
    );
}
