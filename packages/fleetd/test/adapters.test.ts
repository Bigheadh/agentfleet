import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpAdapter } from "../src/adapters/acp.ts";
import { CodexAdapter } from "../src/adapters/codex.ts";
import type { AgentSession } from "../src/adapters/types.ts";
import { fakeContext, fixtureCommand, tempDir } from "./helpers.ts";

const SPEC = { runId: "r1", taskId: "t1", project: "p", runtimeId: "x", prompt: "hi" };
let session: AgentSession | null = null;
afterEach(async () => {
  await session?.close();
  session = null;
});

describe("AcpAdapter (mock ACP agent over stdio)", () => {
  const adapter = () => new AcpAdapter({ id: "acp:mock", agent: "Mock", ...fixtureCommand("mock-acp-agent") });

  it("maps updates, routes permission requests and completes the turn", async () => {
    const cwd = tempDir();
    const { ctx, events, approvals } = fakeContext(cwd, (req) => req.options.find((o) => o.kind === "allow_once")!.id);
    session = await adapter().start({ ...SPEC, runtimeId: "acp:mock" }, ctx);
    const r = await session.prompt("写个文件");
    expect(r.status).toBe("completed");
    expect(readFileSync(join(cwd, "hello.txt"), "utf8")).toContain("turn 1");

    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ toolId: "t1", risk: "write", title: "写入 hello.txt" });
    const types = events.map((e) => e.type);
    expect(types).toContain("message.delta");
    expect(types).toContain("plan.updated");
    expect(types).toContain("usage.updated");
    expect(events.find((e) => e.type === "tool.started")).toMatchObject({ toolId: "t1", kind: "edit" });
    expect(events.find((e) => e.type === "tool.updated" && e.status === "completed")).toMatchObject({ output: "已写入" });
    expect(events.find((e) => e.type === "usage.updated")).toMatchObject({ contextUsed: 1234, costUsd: 0.01 });

    // second turn in the same session (multi-turn)
    expect((await session.prompt("再来")).status).toBe("completed");
    expect(readFileSync(join(cwd, "hello.txt"), "utf8")).toContain("turn 2");
  });

  it("respects a rejection", async () => {
    const cwd = tempDir();
    const { ctx } = fakeContext(cwd, () => "reject");
    session = await adapter().start(SPEC, ctx);
    expect((await session.prompt("写个文件")).status).toBe("completed");
    expect(existsSync(join(cwd, "hello.txt"))).toBe(false);
  });

  it("interrupts a running turn", async () => {
    const { ctx } = fakeContext(tempDir(), () => null);
    session = await adapter().start(SPEC, ctx);
    const p = session.prompt("slow task");
    await new Promise((r) => setTimeout(r, 300));
    await session.interrupt();
    expect((await p).status).toBe("interrupted");
  });

  it("reports a missing binary on probe", async () => {
    const cap = await new AcpAdapter({ id: "acp:nope", agent: "Nope", command: "definitely-not-installed-xyz", args: [] }).probe();
    expect(cap).toMatchObject({ installed: false, tier: "acp" });
  });
});

describe("CodexAdapter (mock app-server over stdio)", () => {
  const adapter = () => {
    const { command, args } = fixtureCommand("mock-codex-app-server");
    return new CodexAdapter({ command, args, probeLogin: false });
  };

  it("runs a turn with a command approval", async () => {
    const cwd = tempDir();
    const { ctx, events, approvals } = fakeContext(cwd, () => "accept");
    session = await adapter().start({ ...SPEC, runtimeId: "codex" }, ctx);
    const r = await session.prompt("做点事");
    expect(r.status).toBe("completed");
    expect(existsSync(join(cwd, "codex.txt"))).toBe(true);
    expect(approvals[0]).toMatchObject({ risk: "exec", command: "sh -c 'echo codex > codex.txt'" });

    expect(events.find((e) => e.type === "tool.started")).toMatchObject({ kind: "execute" });
    expect(events.find((e) => e.type === "tool.updated" && e.outputDelta)).toMatchObject({ outputDelta: "wrote codex.txt\n" });
    expect(events.find((e) => e.type === "tool.updated" && e.status === "completed")).toMatchObject({ exitCode: 0 });
    expect(events.find((e) => e.type === "usage.updated")).toMatchObject({ totalTokens: 150, contextSize: 272000 });
    const text = events.flatMap((e) => (e.type === "message.delta" ? [e.text] : [])).join("");
    expect(text).toContain("codex 收到：做点事");
    expect(text).toContain("完成。");
  });

  it("declines and interrupts", async () => {
    const cwd = tempDir();
    const { ctx } = fakeContext(cwd, () => "decline");
    session = await adapter().start(SPEC, ctx);
    expect((await session.prompt("做点事")).status).toBe("completed");
    expect(existsSync(join(cwd, "codex.txt"))).toBe(false);

    const p = session.prompt("slow");
    await new Promise((r) => setTimeout(r, 200));
    await session.interrupt();
    expect((await p).status).toBe("interrupted");
  });
});
