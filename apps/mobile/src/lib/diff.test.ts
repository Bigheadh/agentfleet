import { describe, expect, it } from "vitest";
import { classifyUnified, countChanges, fileDiffLines, lineDiff } from "./diff";

describe("diff helpers", () => {
  it("classifies unified diff lines", () => {
    const lines = classifyUnified(
      ["diff --git a/x b/x", "index 1..2 100644", "--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", " keep", "-old", "+new", ""].join("\n"),
    );
    expect(lines.map((l) => l.kind)).toEqual(["file", "meta", "meta", "meta", "hunk", "ctx", "del", "add"]);
    expect(countChanges(lines)).toEqual({ additions: 1, deletions: 1 });
  });

  it("computes an LCS line diff", () => {
    const out = lineDiff("a\nb\nc", "a\nx\nc\nd");
    expect(out.map((l) => l.text)).toEqual([" a", "-b", "+x", " c", "+d"]);
  });

  it("handles new and deleted files", () => {
    expect(fileDiffLines({ path: "n.ts", oldText: null, newText: "1\n2" }).map((l) => l.kind)).toEqual([
      "file",
      "meta",
      "add",
      "add",
    ]);
    expect(fileDiffLines({ path: "d.ts", oldText: "1", newText: null }).map((l) => l.kind)).toEqual(["file", "meta", "del"]);
  });

  it("prefers the unified text when present", () => {
    expect(fileDiffLines({ path: "u", unified: "@@ -1 +1 @@\n-a\n+b" }).map((l) => l.kind)).toEqual(["hunk", "del", "add"]);
  });
});
