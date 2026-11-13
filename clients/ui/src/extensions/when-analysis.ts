import { evaluateWhen, type WhenExpression } from "./when.ts";

type WhenValue = string | number | boolean;

// Beyond this many contexts the answer is "may overlap" rather than a long search.
const MAX_CONTEXTS = 4096;
// Truthy and equal to no literal, so it stands for every value a condition does not name.
const OTHER_VALUE = "\u0000other";

export function whenKeys(expression: WhenExpression): ReadonlySet<string> {
    const names = new Set<string>();
    collectKeys(expression, names);
    return names;
}

function collectKeys(expression: WhenExpression, names: Set<string>): void {
    switch (expression.kind) {
        case "true":
            return;
        case "key":
        case "equals":
        case "notEquals":
            names.add(expression.name);
            return;
        case "not":
            collectKeys(expression.operand, names);
            return;
        case "and":
        case "or":
            for (const operand of expression.operands) collectKeys(operand, names);
            return;
    }
}

// False only when no context makes both conditions true.
export function whensOverlap(left: WhenExpression, right: WhenExpression): boolean {
    const values = new Map<string, Set<WhenValue | undefined>>();
    collectValues(left, values);
    collectValues(right, values);

    const names = [...values.keys()];
    let contexts = 1;
    for (const options of values.values()) contexts *= options.size;
    if (contexts > MAX_CONTEXTS) return true;

    const options = names.map((name) => [...(values.get(name) ?? [])]);
    const context = new Map<string, WhenValue | undefined>();
    const search = (index: number): boolean => {
        const name = names[index];
        if (name === undefined) return evaluateWhen(left, context) && evaluateWhen(right, context);
        for (const value of options[index] ?? []) {
            context.set(name, value);
            if (search(index + 1)) return true;
        }
        return false;
    };
    return search(0);
}

// Each key can only matter as undefined, as one of the literals compared to it, or as any other value.
function collectValues(expression: WhenExpression, values: Map<string, Set<WhenValue | undefined>>): void {
    switch (expression.kind) {
        case "true":
            return;
        case "key":
            optionsFor(values, expression.name);
            return;
        case "equals":
        case "notEquals":
            optionsFor(values, expression.name).add(expression.value);
            return;
        case "not":
            collectValues(expression.operand, values);
            return;
        case "and":
        case "or":
            for (const operand of expression.operands) collectValues(operand, values);
            return;
    }
}

function optionsFor(values: Map<string, Set<WhenValue | undefined>>, name: string): Set<WhenValue | undefined> {
    let options = values.get(name);
    if (options === undefined) {
        options = new Set<WhenValue | undefined>([undefined, OTHER_VALUE]);
        values.set(name, options);
    }
    return options;
}
