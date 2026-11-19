export function registeredDifference(reference, actual) {
    let best = { x: 0, y: 0, error: Infinity };
    for (let y = -2; y <= 2; y++) {
        for (let x = -2; x <= 2; x++) {
            let difference = 0;
            for (let row = 2; row < 98; row++) {
                for (let column = 2; column < 198; column++) {
                    const a = (row * 200 + column) * 3;
                    const b = ((row + y) * 200 + column + x) * 3;
                    for (let channel = 0; channel < 3; channel++) difference += Math.abs(reference[a + channel] - actual[b + channel]);
                }
            }
            const error = difference / (196 * 96 * 3);
            if (error < best.error) best = { x, y, error };
        }
    }
    return best;
}

export function captureSizeMatches(size, reference, zoom) {
    return Math.abs(size.width / reference.width - zoom) <= 0.04
        && Math.abs(size.height / reference.height - zoom) <= 0.04;
}
