/**
 * The diff, as the one `state` every question is asked against.
 *
 * Jev's two ceilings are the whole request at 64Ki input tokens and the
 * `state` alone at 32Ki, and the state's is the one that fills up first. A
 * diff over that budget is cut by dropping whole file sections, smallest
 * first, because keeping the greatest NUMBER of files is what a judgment
 * about which tests a change touches actually needs -- one 4000-line
 * generated file should not push nine hand-edited ones out.
 *
 * What was dropped is named in the state rather than silently missing, and
 * `git diff --stat` is carried whole, so a question about a test in an
 * omitted file is answered by a model that at least knows the file changed.
 */
import { splitDiffByFile } from "./diff.ts";

export interface StatePayload {
  reviewing: string;
  changed_files: string[];
  stat: string;
  diff: string;
  truncated: boolean;
  omitted_files: string[];
}

/**
 * Characters, not tokens. The state budget is 32Ki tokens and source text
 * runs near 3.6 characters per token, which would put the ceiling around
 * 118k; 96k leaves room for the estimate being wrong in the direction that
 * costs a request.
 */
export const DEFAULT_MAX_CHARS = 96_000;

export interface StateOptions {
  maxChars?: number;
}

export function buildState(diff: string, stat: string, { maxChars = DEFAULT_MAX_CHARS }: StateOptions = {}): StatePayload {
  const sections = splitDiffByFile(diff);
  const changed = [...sections.keys()];
  const base: StatePayload = {
    reviewing: "a git diff",
    changed_files: changed,
    stat,
    diff,
    truncated: false,
    omitted_files: [],
  };
  if (diff.length <= maxChars) return base;

  const bySize = [...sections.entries()].sort((a, b) => a[1].length - b[1].length);
  const kept: Array<[string, string]> = [];
  let used = 0;
  for (const entry of bySize) {
    if (used + entry[1].length + 1 > maxChars) continue;
    kept.push(entry);
    used += entry[1].length + 1;
  }
  const keptNames = new Set(kept.map(([f]) => f));
  // Emit in the diff's own order, not in size order: a diff read out of order
  // is harder to follow and carries no more information.
  const ordered = changed.filter((f) => keptNames.has(f)).map((f) => sections.get(f)!);
  return {
    ...base,
    diff: ordered.join("\n"),
    truncated: true,
    omitted_files: changed.filter((f) => !keptNames.has(f)),
  };
}
