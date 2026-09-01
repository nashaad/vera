// @ts-nocheck
/**
 * Split clients/tui/settings-picker.ts into family modules + a re-export barrel.
 * One shot. Does not change function bodies.
 */
const fs = require("node:fs");
const ts = require("/Users/nash/Projects/vera/node_modules/typescript/lib/typescript.js");

const SRC = "clients/tui/settings-picker.ts";

const FILES = {
    types: "clients/tui/settings-picker-types.ts",
    model: "clients/tui/settings-picker-model.ts",
    starters: "clients/tui/settings-picker-starters.ts",
    view: "clients/tui/settings-picker-view.ts",
    form: "clients/tui/settings-picker-provider-form.ts",
};

const DAG = {
    types: [],
    form: ["types"],
    model: ["types"],
    starters: ["types", "model"],
    view: ["types", "model", "starters"],
};

const TYPES = new Set([
    "TuiSettingsPickerKind",
    "TuiSettingsMenuTarget",
    "TuiSettingsMenuKind",
    "TuiDeveloperKey",
    "TuiReviewerSlot",
    "TuiSettingsPickerOption",
    "TuiConfigureFile",
    "TuiProviderRow",
    "TuiProviderGroup",
    "TUI_PROVIDER_GROUP_RANK",
    "tuiProviderGroup",
    "TuiModelPickerTab",
    "TuiExtensionPickerRow",
    "TuiExtensionPickerActionKey",
    "TuiExtensionPickerAction",
    "TuiSettingsPickerState",
    "TuiAssignmentParentModel",
    "TuiPendingModelChoice",
    "TuiExtensionPickerState",
    "TuiSettingsPickerKey",
    "TuiSettingsPickerSelection",
    "TuiPoolToggle",
    "TuiPoolNameCandidate",
    "TuiPoolVerify",
    "TuiModelRequestOptionsSupport",
    "TuiModelRequestOptionsCandidate",
    "TuiSettingsPickerTransition",
    "TuiExtensionPickerSelection",
    "TuiExtensionPickerTransition",
    "TuiAnySettingsPickerState",
    "TuiSettingsPickerView",
    "TUI_DECLARE_PROVIDER_VALUE",
    "withTuiPickerParent",
    "tuiPickerMenuAncestor",
    "REVIEWER_CLEAR_VALUE",
    "MODEL_ASSIGNMENT_BROWSE_VALUE",
    "MODEL_ASSIGNMENT_SELF_VALUE",
    "MODEL_ASSIGNMENT_VALUE_PREFIX",
    "SESSION_MODEL_VALUE",
    "MODEL_ACTION_VALUE_PREFIX",
    "CONTEXT_LIMIT_VALUE",
    "tuiModelAssignmentValue",
    "tuiModelActionOptions",
    "tuiModelActionValue",
    "tuiModelActionOfValue",
    "modelAssignmentOfValue",
    "tuiModelAssignmentOptions",
    "formatContextLimitOption",
    "sessionRunsFact",
    "assignmentStatusWord",
    "assignmentRunsFact",
    "assignmentFacts",
    "assignmentNote",
    "POOL_VERIFY_UNVERIFIED_VALUE",
    "POOL_VERIFY_ALL_VALUE",
    "CATALOG_REFRESH_ALL_VALUE",
    "TUI_TOP_PICKS_SECTION",
    "formatSessionSize",
]);

const FORM = new Set([
    "TuiProviderFormFieldId",
    "TUI_PROVIDER_FORM_FIELDS",
    "tuiProviderFormFields",
    "TuiProviderFormState",
    "TuiProviderFormDeclaration",
    "TuiProviderFormKey",
    "TuiProviderFormTransition",
    "TuiProviderFormView",
    "startTuiProviderForm",
    "handleTuiProviderFormPaste",
    "handleTuiProviderFormKey",
    "movedProviderFormField",
    "submittedProviderForm",
    "providerFormError",
    "providerFormTextField",
    "providerFormFieldValue",
    "editedProviderFormField",
    "toggledProviderFormChoice",
    "tuiProviderFormRows",
    "PROVIDER_FORM_CONTROL_CHARACTERS",
    "PROVIDER_FORM_CONTROL_RUN",
    "PROVIDER_FORM_LABELS",
    "PROVIDER_FORM_PLACEHOLDERS",
    "createTuiProviderFormView",
]);

const STARTERS = new Set([
    "PERMISSION_OPTIONS",
    "tuiPermissionModeDescription",
    "THEME_OPTIONS",
    "startTuiSettingsPicker",
    "syncTuiModelPicker",
    "startTuiConfigurePicker",
    "startTuiReasoningPicker",
    "levelOption",
    "permissionOptions",
    "SETTINGS_MENU_OPTIONS",
    "CONTEXT_LIMIT_OPTIONS",
    "startTuiContextLimitPicker",
    "DeveloperValueRow",
    "DEVELOPER_VALUE_ROWS",
    "startTuiDeveloperMenu",
    "startTuiDeveloperValuePicker",
    "PERMISSION_SETTINGS_OPTIONS",
    "startTuiProviderPicker",
    "TUI_DECLARE_PROVIDER_OPTION",
    "tuiPickerAfterSelection",
    "reviewerSlotLabel",
    "startTuiReviewerMenu",
    "startTuiReviewerPicker",
    "startTuiPoolVerifyScopePicker",
    "startTuiCatalogRefreshScopePicker",
    "startTuiModelAssignmentPicker",
    "unsetAssignmentMeans",
    "settingsMenuOptions",
    "startTuiSettingsMenu",
    "startTuiSessionPicker",
    "markSharedSessionOptions",
    "startTuiExtensionPicker",
    "SESSION_WORKSPACE_CELLS",
    "SESSION_TITLE_LIMIT",
    "threadSessionOptions",
    "sessionTitle",
    "sessionWorkspace",
    "clipToCells",
    "sessionActivity",
    "sessionPickerLists",
]);

const VIEW = new Set([
    "handleTuiExtensionPickerKey",
    "extensionPickerActionKey",
    "handleTuiSettingsPickerKey",
    "handleTuiSettingsPickerScroll",
    "updateTuiSettingsPickerSearch",
    "createTuiSettingsPickerView",
    "FALLBACK_JUMP",
    "pickerMaxRows",
    "THEME_CARD_CHROME_LINES",
    "themePickerTop",
    "tuiPickerViewportRows",
    "PickerDisplayRow",
    "renderListPickerRows",
    "VERIFICATION_CONSOLE_STEPS",
    "VerificationConsole",
    "verificationConsoleLines",
    "verificationConsoleNode",
    "VERIFICATION_STEP_MARKS",
    "PickerHint",
    "clippedToWidth",
    "fittedHints",
    "pickerFooter",
    "pickerFooterText",
    "hasFoldedRows",
    "extensionPickerKeyLabel",
    "listDisplayRows",
    "groupLabel",
    "windowedDisplayRows",
    "isHeadingRow",
    "stickyGroupRow",
    "isCurrentOption",
    "digitQuickSelect",
    "optionMarker",
    "optionLeading",
    "THEME_LABEL_WIDTH",
    "renderThemePickerRows",
    "themeRowContent",
    "themeSwatchChunks",
    "emptyPickerMessage",
    "pickerTitle",
]);

function fail(message) {
    console.error(message);
    process.exit(1);
}

function namesOf(stmt) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) return [stmt.name.text];
    if (
        ts.isTypeAliasDeclaration(stmt)
        || ts.isInterfaceDeclaration(stmt)
        || ts.isEnumDeclaration(stmt)
        || ts.isClassDeclaration(stmt)
    ) {
        return stmt.name ? [stmt.name.text] : [];
    }
    if (ts.isVariableStatement(stmt)) {
        return stmt.declarationList.declarations
            .filter((d) => ts.isIdentifier(d.name))
            .map((d) => d.name.text);
    }
    return [];
}

function fileOf(name) {
    if (TYPES.has(name)) return "types";
    if (FORM.has(name)) return "form";
    if (STARTERS.has(name)) return "starters";
    if (VIEW.has(name)) return "view";
    return "model";
}

function ensureExport(text) {
    if (/^export\s/.test(text) || /^\/\*\*/.test(text) && /\nexport\s/.test(text)) {
        return text;
    }
    if (text.startsWith("/**") || text.startsWith("//") || text.startsWith("/*")) {
        const match = text.match(/^((?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*)/);
        const prefix = match ? match[1] : "";
        const rest = text.slice(prefix.length);
        if (/^export\s/.test(rest)) return text;
        return `${prefix}export ${rest}`;
    }
    return `export ${text}`;
}

const source = fs.readFileSync(SRC, "utf8");
const sf = ts.createSourceFile(SRC, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);

const importEnd = (() => {
    let end = 0;
    for (const stmt of sf.statements) {
        if (ts.isImportDeclaration(stmt)) end = stmt.getEnd();
    }
    if (source[end] === "\n") end += 1;
    return end;
})();
const importBlock = source.slice(0, importEnd).trimEnd();

const buckets = {
    types: [],
    model: [],
    starters: [],
    view: [],
    form: [],
};
const owner = new Map();
const assigned = new Set();

for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) continue;
    const names = namesOf(stmt);
    if (names.length === 0) fail(`unnamed statement at ${stmt.getStart(sf)}`);
    const files = new Set(names.map(fileOf));
    if (files.size !== 1) {
        fail(`statement ${names.join(",")} splits across ${[...files].join(",")}`);
    }
    const file = [...files][0];
    for (const name of names) {
        owner.set(name, file);
        assigned.add(name);
    }
    const start = stmt.getFullStart();
    const text = source.slice(start, stmt.getEnd()).replace(/^\n+/, "");
    buckets[file].push({ names, text: ensureExport(text), stmt });
}

const known = new Set([...TYPES, ...FORM, ...STARTERS, ...VIEW]);
const extras = [...assigned].filter((n) => !known.has(n));
console.log(`model received ${extras.length} remaining symbols`);

const violations = [];

function usedForeign(file) {
    const need = new Map();
    function walk(node) {
        if (ts.isIdentifier(node)) {
            if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
                ts.forEachChild(node, walk);
                return;
            }
            if (
                (ts.isFunctionDeclaration(node.parent)
                    || ts.isTypeAliasDeclaration(node.parent)
                    || ts.isInterfaceDeclaration(node.parent)
                    || ts.isEnumDeclaration(node.parent)
                    || ts.isClassDeclaration(node.parent))
                && node.parent.name === node
            ) {
                return;
            }
            if (ts.isVariableDeclaration(node.parent) && node.parent.name === node) return;
            const from = owner.get(node.text);
            if (from && from !== file) {
                if (!DAG[file].includes(from)) {
                    violations.push(`${file} uses ${node.text} from ${from}`);
                }
                let set = need.get(from);
                if (!set) {
                    set = new Set();
                    need.set(from, set);
                }
                set.add(node.text);
            }
        }
        ts.forEachChild(node, walk);
    }
    for (const piece of buckets[file]) walk(piece.stmt);
    return need;
}

for (const file of Object.keys(FILES)) usedForeign(file);
if (violations.length) {
    fail([...new Set(violations)].sort().join("\n"));
}

for (const [file, dest] of Object.entries(FILES)) {
    const body = buckets[file].map((p) => p.text).join("\n\n");
    const need = usedForeign(file);
    const siblingImports = [];
    for (const dep of DAG[file]) {
        const names = [...(need.get(dep) ?? [])].sort();
        if (names.length === 0) continue;
        const spec = `./${FILES[dep].split("/").pop()}`;
        siblingImports.push(`import {\n    ${names.join(",\n    ")},\n} from "${spec}";`);
    }
    const parts = [importBlock, ...siblingImports, body];
    fs.writeFileSync(dest, `${parts.filter(Boolean).join("\n\n")}\n`);
    console.log(`wrote ${dest} (${buckets[file].length} decls)`);
}

const barrel = Object.values(FILES)
    .map((p) => `export * from "./${p.split("/").pop()}";`)
    .join("\n");
fs.writeFileSync(SRC, `${barrel}\n`);
console.log(`wrote barrel ${SRC}`);
