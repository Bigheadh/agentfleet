import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FleetEvent, NodeToHub } from "@agentfleet/proto";
import { describe, expect, it } from "vitest";
import { diffsOf } from "../src/adapters/acp.ts";
import { customProvider } from "../src/adapters/codex.ts";
import type { AgentAdapter } from "../src/adapters/types.ts";
import { NodeConfig } from "../src/config.ts";
import { classifyStderr } from "../src/proc.ts";
import { Runner } from "../src/runner.ts";
import { tempDir, tempRepo, waitFor } from "./helpers.ts";

// Regression tests for issues found while running real Codex / Gemini / Claude.

describe("customProvider (codex login status says 'Not logged in' for custom providers)", () => {
  it("detects a top-level model_provider", () => {
    const home = tempDir();
    writeFileSync(join(home, "config.toml"), 'model = "x"\nmodel_provider = "relay"\n\n[model_providers.relay]\nbase_url = "https://r/v1"\n');
    expect(customProvider({ CODEX_HOME: home })).toBe("relay");
  });
  it("ignores provider keys inside tables and the default openai provider", () => {
    const home = tempDir();
    writeFileSync(join(home, "config.toml"), '[profiles.p]\nmodel_provider = "relay"\n');
    expect(customProvider({ CODEX_HOME: home })).toBeNull();
    writeFileSync(join(home, "config.toml"), 'model_provider = "openai"\n');
    expect(customProvider({ CODEX_HOME: home })).toBeNull();
    expect(customProvider({ CODEX_HOME: home, OPENAI_API_KEY: "k" })).toBe("OPENAI_API_KEY");
  });
  it("handles a missing config", () => {
    const home = join(tempDir(), "nope");
    mkdirSync(home);
    expect(customProvider({ CODEX_HOME: home })).toBeNull();
  });
});

describe("diffsOf (Gemini sends absolute worktree paths)", () => {
  it("relativizes paths inside cwd only", () => {
    const d = diffsOf(
      [
        { type: "diff", path: "/wt/run-1/src/a.ts", oldText: "", newText: "x" },
        { type: "diff", path: "/etc/hosts", oldText: null, newText: "y" },
      ],
      "/wt/run-1",
    );
    expect(d?.map((x) => x.path)).toEqual(["src/a.ts", "/etc/hosts"]);
  });
});

describe("classifyStderr (Codex reported a missing sandbox only on stderr)", () => {
  it("promotes ANSI-coloured ERROR lines", () => {
    const r = classifyStderr("\x1b[2m2026\x1b[0m \x1b[31mERROR\x1b[0m codex_app_server: Codex could not find bubblewrap");
    expect(r).toEqual({ level: "warn", text: "2026 ERROR codex_app_server: Codex could not find bubblewrap" });
    expect(classifyStderr("loading config").level).toBe("debug");
  });
});

describe("Runner text coalescing (Codex streams one event per token)", () => {
  it("merges consecutive deltas and keeps ordering around other events", async () => {
    const tokens = "I will create hello.txt now .".split(" ");
    const adapter: AgentAdapter = {
      id: "fake",
      probe: async () => ({ id: "fake", agent: "fake", tier: "native", version: null, installed: true, loggedIn: null, models: [], supports: [] }),
      start: async (_spec, ctx) => ({
        prompt: async () => {
          for (const t of tokens) ctx.emit({ type: "message.delta", role: "agent", text: t + " " });
          ctx.emit({ type: "reasoning.delta", text: "a" });
          ctx.emit({ type: "reasoning.delta", text: "b" });
          ctx.emit({ type: "tool.started", toolId: "t1", title: "cmd", kind: "execute" });
          ctx.emit({ type: "message.delta", role: "agent", text: "done" });
          await new Promise((r) => setTimeout(r, 300)); // timer flush path
          ctx.emit({ type: "message.delta", role: "agent", text: "!" });
          return { status: "completed" };
        },
        interrupt: async () => {},
        close: async () => {},
      }),
    };
    const cfg = NodeConfig.parse({ hub: "http://127.0.0.1:1", nodeId: "n", token: "t", name: "n", workRoot: tempDir(), projects: { demo: { path: tempRepo() } } });
    const sent: NodeToHub[] = [];
    const runner = new Runner({ cfg, adapters: new Map([["fake", adapter]]), send: (m) => sent.push(m), statePath: join(tempDir(), "s.json"), log: () => {} });
    await runner.assign({ runId: "run-coalesce-1", taskId: "t", project: "demo", runtimeId: "fake", prompt: "go" });
    await waitFor(() => sent.some((m) => m.type === "run.ended"), 10_000, "run.ended");
    await runner.shutdown();

    const evs = sent.flatMap((m) => (m.type === "run.event" ? [m] : []));
    const agentText = evs.flatMap((m) => (m.event.type === "message.delta" && m.event.role === "agent" ? [m.event.text] : []));
    expect(agentText).toEqual(["I will create hello.txt now . ", "done", "!"]);
    const kinds = evs.map((m) => m.event.type).filter((t) => t !== "run.status" && t !== "diff.updated");
    expect(kinds).toEqual(["message.delta", "message.delta", "reasoning.delta", "tool.started", "message.delta", "message.delta"]);
    expect(evs.find((m) => m.event.type === "reasoning.delta")!.event).toMatchObject({ text: "ab" });
    expect(evs.map((m) => m.seq)).toEqual(evs.map((_, i) => i));
    const userMsg: FleetEvent | undefined = evs.find((m) => m.event.type === "message.delta")?.event;
    expect(userMsg).toMatchObject({ role: "user", text: "go" });
  });
});

describe("Worktrees junk excludes (Gemini committed __pycache__/*.pyc)", () => {
  it("leaves cache artifacts out of diff and commit", async () => {
    const { Worktrees } = await import("../src/worktree.ts");
    const { execFileSync } = await import("node:child_process");
    const repo = tempRepo();
    const wts = new Worktrees(tempDir());
    const wt = await wts.create(repo, "demo", "run-junk-0001");
    writeFileSync(join(wt.path, "calc.py"), "def add(a, b):\n    return a + b\n");
    mkdirSync(join(wt.path, "__pycache__"));
    writeFileSync(join(wt.path, "__pycache__", "calc.cpython-312.pyc"), "\0\0bin");
    mkdirSync(join(wt.path, "node_modules", "x"), { recursive: true });
    writeFileSync(join(wt.path, "node_modules", "x", "i.js"), "1");

    const d = await wts.diff(wt);
    expect(d.files).toBe(1);
    expect(d.unified).not.toContain("__pycache__");

    await wts.commit(wt, "fix");
    const files = execFileSync("git", ["-C", wt.path, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf8" }).trim().split("\n");
    expect(files).toEqual(["calc.py"]);
    expect(await wts.commit(wt, "again")).toBe("没有需要提交的改动");
  });
});
