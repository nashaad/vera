import { normalizePermissionRulePath } from "../engine/permission-rules.ts";
import type { PermissionRule } from "../engine/permissions.ts";
import { configProblem, expectedValue, isPlainObject, keyValue } from "./diagnostic.ts";
import { parsePredicate } from "./permission-modes.ts";

const OUTCOMES = new Set(["allow", "ask", "deny"]);

export function parsePermissionRules(
    value: unknown,
): readonly PermissionRule[] | undefined {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        return configProblem(
            "permission_rules",
            expectedValue("a list of rules", value),
        );
    }
    const rules: PermissionRule[] = [];
    for (let index = 0; index < value.length; index += 1) {
        const field = `permission_rules[${index}]`;
        const ruleValue = value[index];
        if (!isPlainObject(ruleValue)) {
            return configProblem(field, expectedValue("an object", ruleValue));
        }
        if (ruleValue.then === "review") {
            return configProblem(
                field,
                "then review is not allowed in permission_rules: in ask mode it would deny. Use a permission_modes entry with a reviewer_profile.",
            );
        }
        if (!OUTCOMES.has(ruleValue.then as string)) {
            return configProblem(
                field,
                keyValue("then", "allow, ask or deny", ruleValue.then),
            );
        }
        let when = parsePredicate(ruleValue.when, field);
        if (when === undefined) {
            return undefined;
        }
        if (when.path !== undefined) {
            const path = normalizePermissionRulePath(when.path);
            if (path === undefined) {
                return configProblem(
                    `${field}.when`,
                    `path ${JSON.stringify(when.path)} must be absolute or start with ~/`,
                );
            }
            when = { ...when, path };
        }
        rules.push({
            name: `permission_rules.${index}`,
            when,
            then: ruleValue.then as PermissionRule["then"],
        });
    }
    return rules;
}
