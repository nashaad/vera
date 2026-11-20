import { builtinRecord } from "./registry.ts";
import type { ThemeFile, ThemeName } from "./tokens.ts";
import dark from "./themes/dark.json";
import light from "./themes/light.json";
import highContrast from "./themes/high-contrast.json";
import veraBlue from "./themes/default.json";
import veraPurple from "./themes/vera-purple.json";
import mutedBlue from "./themes/muted-blue.json";
import onyx from "./themes/onyx.json";
import palenight from "./themes/palenight.json";
import synthwave from "./themes/synthwave.json";
import nightOwl from "./themes/nightowl.json";
import github from "./themes/github.json";
import githubLight from "./themes/github-light.json";
import gruvboxDarkHard from "./themes/gruvbox-dark-hard.json";
import gruvboxLightHard from "./themes/gruvbox-light-hard.json";
import midnightBlue from "./themes/midnight-blue.json";
import midnightBlueII from "./themes/midnight-blue-ii.json";
import nc from "./themes/norton-commander.json";
import ncNavy from "./themes/nc-navy.json";
import retro31 from "./themes/windows-31.json";
import veraOrange from "./themes/vera-orange.json";

const files: readonly ThemeFile[] = [
    dark, light, highContrast, veraBlue, veraPurple, mutedBlue, onyx, palenight,
    synthwave, nightOwl, github, githubLight, gruvboxDarkHard, gruvboxLightHard,
    midnightBlue, midnightBlueII, nc, ncNavy, retro31, veraOrange,
];
const filesByName = new Map(files.map((file) => [file.name, file]));

export const BUILTIN_THEMES: Readonly<Record<ThemeName, ThemeFile>> = builtinRecord((theme) => {
    const file = filesByName.get(theme.name);
    if (file === undefined) throw new Error(`Missing built-in theme file: ${theme.name}`);
    return file;
});
export const BUILTIN_COLOR_SCHEME = builtinRecord((theme) => theme.colorScheme);
