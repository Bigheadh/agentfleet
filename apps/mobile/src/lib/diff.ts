/**
 * Tiny, dependency-free diff helpers used by the DiffView component.
 * Pure functions (no React Native imports) so they can be unit-tested.
 */
import type { FileDiff } from "@agentfleet/proto";

export type DiffLineKind = "file" | "meta" | "hunk" | "add" | "del" | "ctx";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/** Classify each line of a unified diff for coloring. */
export function classifyUnified(unified: string): DiffLine[] {
  const lines = unified.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((text): DiffLine => {
    if (text.startsWith("diff --git") || text.startsWith("Index: ")) return { kind: "file", text };
    if (text.startsWith("+++") || text.startsWith("---")) return { kind: "meta", text };
    if (
      text.startsWith("index ") ||
      text.startsWith("new file mode") ||
      text.startsWith("deleted file mode") ||
      text.startsWith("similarity index") ||
      text.startsWith("rename ") ||
      text.startsWith("\\ No newline")
    )
      return { kind: "meta", text };
    if (text.startsWith("@@")) return { kind: "hunk", text };
    if (text.startsWith("+")) return { kind: "add", text };
    if (text.startsWith("-")) return { kind: "del", text };
    return { kind: "ctx", text };
  });
}

/** Above this many cells (old lines × new lines) we skip LCS and show a full replace. */
const LCS_LIMIT = 250_000;

/**
 * Line-level diff between two texts (LCS). Returns +/-/space prefixed lines
 * without hunk headers; good enough to render agent-provided old/new text.
 */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText === "" ? [] : oldText.replace(/\r\n/g, "\n").split("\n");
  const b = newText === "" ? [] : newText.replace(/\r\n/g, "\n").split("\n");
  const n = a.length;
  const m = b.length;
  if (n * m > LCS_LIMIT) {
    return [
      ...a.map((t): DiffLine => ({ kind: "del", text: `-${t}` })),
      ...b.map((t): DiffLine => ({ kind: "add", text: `+${t}` })),
    ];
  }
  // dp[i][j] = LCS length of a[i..] and b[j..], stored flat.
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "ctx", text: ` ${a[i]}` });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) {
      out.push({ kind: "del", text: `-${a[i]}` });
      i++;
    } else {
      out.push({ kind: "add", text: `+${b[j]}` });
      j++;
    }
  }
  while (i < n) out.push({ kind: "del", text: `-${a[i++]}` });
  while (j < m) out.push({ kind: "add", text: `+${b[j++]}` });
  return out;
}

/** Render a FileDiff (as emitted in tool / approval events) into classified lines. */
export function fileDiffLines(diff: FileDiff): DiffLine[] {
  if (diff.unified) return classifyUnified(diff.unified);
  const header: DiffLine = { kind: "file", text: diff.path };
  if (diff.oldText == null && diff.newText != null) {
    return [header, { kind: "meta", text: "(new file)" }, ...lineDiff("", diff.newText)];
  }
  if (diff.oldText != null && diff.newText == null) {
    return [header, { kind: "meta", text: "(deleted)" }, ...lineDiff(diff.oldText, "")];
  }
  return [header, ...lineDiff(diff.oldText ?? "", diff.newText ?? "")];
}

export function countChanges(lines: readonly DiffLine[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const l of lines) {
    if (l.kind === "add") additions++;
    else if (l.kind === "del") deletions++;
  }
  return { additions, deletions };
}
