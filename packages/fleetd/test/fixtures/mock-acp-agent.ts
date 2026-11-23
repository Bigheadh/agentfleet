/**
 * Minimal ACP agent used by tests (spawned as a real child process over stdio).
 *
 * Each prompt: message chunk -> plan -> tool_call(edit hello.txt) -> request_permission
 * -> writes hello.txt only if allowed -> tool_call_update -> usage_update -> end_turn.
 * A prompt containing "slow" blocks until session/cancel (tests interrupt).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const sessions = new Map<string, { cwd: string; turn: number; cancel?: () => void }>();

const app = acp
  .agent({ name: "mock-acp-agent" })
  .onRequest(acp.methods.agent.initialize as never, (() => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
    agentInfo: { name: "mock-acp-agent", version: "0.0.1" },
    authMethods: [],
  })) as never)
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    const sessionId = `s${sessions.size + 1}`;
    sessions.set(sessionId, { cwd: params.cwd, turn: 0 });
    return { sessionId };
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    sessions.get(params.sessionId)?.cancel?.();
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const s = sessions.get(params.sessionId)!;
    s.turn++;
    const text = params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
    const update = (u: acp.SessionUpdate) =>
      client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: u });

    await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `收到：${text}` } });

    if (text.includes("slow")) {
      await new Promise<void>((resolve) => (s.cancel = resolve));
      return { stopReason: "cancelled" };
    }

    await update({
      sessionUpdate: "plan",
      entries: [{ content: "写入 hello.txt", priority: "high", status: "in_progress" }],
    });
    const toolCallId = `t${s.turn}`;
    const newText = `hello from mock acp (turn ${s.turn})\n`;
    await update({
      sessionUpdate: "tool_call",
      toolCallId,
      title: "写入 hello.txt",
      kind: "edit",
      status: "pending",
      rawInput: { path: "hello.txt" },
      content: [{ type: "diff", path: "hello.txt", oldText: null, newText }],
    });
    const perm = await client.request(acp.methods.client.session.requestPermission, {
      sessionId: params.sessionId,
      toolCall: { toolCallId, title: "写入 hello.txt", kind: "edit" },
      options: [
        { optionId: "allow", name: "允许", kind: "allow_once" },
        { optionId: "reject", name: "拒绝", kind: "reject_once" },
      ],
    });
    const allowed = perm.outcome.outcome === "selected" && perm.outcome.optionId === "allow";
    if (allowed) writeFileSync(join(s.cwd, "hello.txt"), newText);
    await update({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: allowed ? "completed" : "failed",
      content: [{ type: "content", content: { type: "text", text: allowed ? "已写入" : "被拒绝" } }],
    });
    await update({ sessionUpdate: "usage_update", used: 1234, size: 200000, cost: { amount: 0.01, currency: "USD" } });
    await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: allowed ? "完成。" : "未获批准。" } });
    return { stopReason: "end_turn" };
  });

const conn = app.connect(
  acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>),
);
void conn;
process.stdin.on("end", () => process.exit(0));
