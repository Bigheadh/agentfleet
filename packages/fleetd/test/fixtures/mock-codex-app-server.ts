/**
 * Minimal `codex app-server` stand-in (JSONL JSON-RPC over stdio) for tests.
 *
 * turn/start -> agentMessage delta -> plan -> commandExecution item ->
 * server request item/commandExecution/requestApproval -> writes codex.txt if
 * accepted -> outputDelta -> item/completed -> tokenUsage -> turn/completed.
 * A prompt containing "slow" waits for turn/interrupt.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

type Msg = { id?: number | string; method?: string; params?: any; result?: any; error?: any };

let cwd = process.cwd();
let nextServerId = 1000;
let turnNo = 0;
const pending = new Map<number | string, (result: any) => void>();
const interrupts = new Map<string, () => void>();

const send = (m: Msg) => process.stdout.write(JSON.stringify(m) + "\n");
const notify = (method: string, params: unknown) => send({ method, params });
const request = (method: string, params: unknown) =>
  new Promise<any>((resolve) => {
    const id = nextServerId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });

async function runTurn(threadId: string, turnId: string, text: string) {
  notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
  notify("item/agentMessage/delta", { threadId, turnId, itemId: `msg-${turnId}`, delta: `codex 收到：${text}` });
  if (text.includes("slow")) {
    await new Promise<void>((r) => interrupts.set(turnId, r));
    notify("turn/completed", { threadId, turn: { id: turnId, status: "interrupted", error: null } });
    return;
  }
  notify("turn/plan/updated", { threadId, turnId, plan: [{ step: "创建 codex.txt", status: "inProgress" }] });
  const itemId = `cmd-${turnId}`;
  const command = "sh -c 'echo codex > codex.txt'";
  notify("item/started", { threadId, turnId, item: { id: itemId, type: "commandExecution", command, cwd, status: "inProgress" } });
  const res = await request("item/commandExecution/requestApproval", { threadId, turnId, itemId, command, cwd, reason: "需要写文件" });
  const ok = res?.decision === "accept" || res?.decision === "acceptForSession";
  if (ok) {
    writeFileSync(join(cwd, "codex.txt"), "codex\n");
    notify("item/commandExecution/outputDelta", { threadId, turnId, itemId, delta: "wrote codex.txt\n" });
  }
  notify("item/completed", {
    threadId,
    turnId,
    item: { id: itemId, type: "commandExecution", command, cwd, status: ok ? "completed" : "declined", exitCode: ok ? 0 : null, aggregatedOutput: ok ? "wrote codex.txt\n" : "" },
  });
  notify("thread/tokenUsage/updated", {
    threadId,
    turnId,
    tokenUsage: {
      total: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      last: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      modelContextWindow: 272000,
    },
  });
  notify("item/completed", { threadId, turnId, item: { id: `msg2-${turnId}`, type: "agentMessage", text: ok ? "完成。" : "命令被拒绝。" } });
  notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", error: null } });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line) as Msg;
  if (msg.method === undefined && msg.id !== undefined) {
    pending.get(msg.id)?.(msg.result);
    pending.delete(msg.id);
    return;
  }
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return send({ id, result: { userAgent: "mock-codex/0.0.1" } });
    case "initialized":
      return;
    case "thread/start":
      cwd = params?.cwd ?? cwd;
      return send({ id, result: { thread: { id: "thread-1" }, model: params?.model ?? "mock-model" } });
    case "turn/start": {
      const turnId = `turn-${++turnNo}`;
      const text = (params?.input ?? []).map((i: any) => i.text ?? "").join("");
      send({ id, result: { turn: { id: turnId, status: "inProgress" } } });
      void runTurn(params.threadId, turnId, text);
      return;
    }
    case "turn/interrupt":
      interrupts.get(params?.turnId)?.();
      return send({ id, result: {} });
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `unknown method ${method}` } });
  }
});
rl.on("close", () => process.exit(0));
