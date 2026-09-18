// Sub-cent totals are common for cheap models, so they keep four decimals.
export function money(usd: number): string {
    const size = Math.abs(usd);
    if (size === 0 || size >= 0.01) return `$${usd.toFixed(2)}`;
    if (size < 0.0001) return usd < 0 ? "-<$0.0001" : "<$0.0001";
    return `$${usd.toFixed(4)}`;
}
