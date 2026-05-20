import type { LockfileAdapter } from "./types";

// pixi skills lockfile. Pixi uses YAML for its lockfiles (pixi.lock), and a
// "pixi-skills" extension would inherit that. We don't ship a YAML parser
// (would add ~25 KB and js-yaml is the de facto choice but unmaintained), so
// v1 of this adapter is detect-only — the import dialog tells the user to
// convert to JSON before importing. Real YAML support lands when the spec
// settles + we pick a parser.
//
// Detection looks for the distinctive `pixi:` or `# pixi-skills` markers at
// the top of a YAML file, plus a `version:` line at depth 0.

const PIXI_HEADER = /^(?:#\s*pixi-skills|pixi-skills:|pixi:)/m;

export const pixiAdapter: LockfileAdapter = {
  format: "pixi",

  detect: (raw, _parsed) => {
    // YAML doesn't parse cleanly as JSON, so `parsed` will be a string or
    // null here; rely on the raw text signature.
    return typeof raw === "string" && PIXI_HEADER.test(raw);
  },

  parse: () => {
    throw new Error(
      "pixi lockfile import not yet supported — please export to JSON (skillsafe-v1 format) and re-import. " +
      "Track progress at https://github.com/skillsafe/ai-skillsafe-app/issues",
    );
  },

  serialize: () => {
    throw new Error("pixi lockfile export not yet supported.");
  },
};
