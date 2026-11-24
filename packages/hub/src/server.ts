/** HTTP REST + WebSocket transport for the hub. No framework — just node:http + ws. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  ApprovalDecisionRequest,
  ClientToHub,
  InputRequest,
  isValidPublicKey,
  type MeResponse,
  NodeToHub,
  PairRequest,
  RegisterKeyRequest,
  RegisterPushRequest,
  RunActionRequest,
} from "@agentfleet/proto";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { type ClientConn, type Hub, HubError, type NodeConn } from "./hub.ts";

type Handler = (ctx: { req: IncomingMessage; params: string[]; body: unknown; actor: string; url: URL }) => unknown | Promise<unknown>;
interface Route {
  method: string;
  pattern: RegExp;
  auth: "device" | "none";
  handler: Handler;
}

const MAX_BODY = 1024 * 1024;
const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[^\]]+\]$/;
const deviceIdOf = (actor: string) => actor.replace(/^device:/, "");

export function createHubServer(hub: Hub): Server {
  const routes: Route[] = [];
  const route = (method: string, path: string, auth: Route["auth"], handler: Handler) => {
    const pattern = new RegExp("^" + path.replace(/:[a-zA-Z]+/g, "([^/]+)") + "$");
    routes.push({ method, pattern, auth, handler });
  };

  // ---- public ---------------------------------------------------------------
  route("GET", "/healthz", "none", () => ({ ok: true, name: hub.name }));
  route("POST", "/api/pair", "none", ({ body }) => {
    const { code, deviceName, publicKey } = PairRequest.parse(body);
    if (publicKey && !isValidPublicKey(publicKey)) throw new HubError(400, "无效的 X25519 公钥");
    const r = hub.store.pairDevice(code, deviceName, publicKey);
    if (!r) throw new HubError(401, "配对码无效或已过期");
    return { token: r.token, deviceId: r.id, hubName: hub.name };
  });
  route("POST", "/api/nodes/join", "none", ({ body }) => {
    const { joinToken, name } = z.object({ joinToken: z.string(), name: z.string().min(1).max(64) }).parse(body);
    const r = hub.store.joinNode(joinToken, name);
    if (!r) throw new HubError(401, "join token 无效或已过期");
    return r;
  });

  // ---- device-authenticated ----------------------------------------------------
  route("GET", "/api/me", "device", ({ actor }): MeResponse => ({
    actor,
    hubName: hub.name,
    push: {
      expoEnabled: hub.notifier?.expoEnabled ?? false,
      registered: hub.store.pushToken(deviceIdOf(actor)) !== null,
      channels: hub.notifier?.channels() ?? [],
    },
    e2ee: {
      publicKey: hub.store.devicePublicKey(deviceIdOf(actor)),
      devicePublicKeys: hub.store.allDevicePublicKeys(),
    },
  }));
  route("POST", "/api/devices/me/key", "device", ({ body, actor }) => {
    const { publicKey } = RegisterKeyRequest.parse(body);
    if (!isValidPublicKey(publicKey)) throw new HubError(400, "无效的 X25519 公钥");
    hub.store.setDevicePublicKey(deviceIdOf(actor), publicKey);
    hub.store.audit(actor, "e2ee.key");
    return { ok: true };
  });
  route("POST", "/api/devices/me/push", "device", ({ body, actor }) => {
    const { expoPushToken } = RegisterPushRequest.parse(body);
    if (expoPushToken !== null && !EXPO_TOKEN_RE.test(expoPushToken)) throw new HubError(400, "不是有效的 Expo push token");
    if (expoPushToken !== null && !hub.notifier?.expoEnabled) throw new HubError(409, "hub 未启用 Expo 推送");
    hub.store.setPushToken(deviceIdOf(actor), expoPushToken);
    hub.store.audit(actor, expoPushToken ? "push.register" : "push.unregister");
    return { ok: true };
  });
  route("GET", "/api/devices", "device", ({ actor }) => {
    const me = deviceIdOf(actor);
    return hub.store.listDevices().map((d) => ({ ...d, current: d.id === me }));
  });
  route("POST", "/api/devices/:id/revoke", "device", ({ params, actor }) => {
    hub.revokeDevice(decodeURIComponent(params[0]!), actor);
    return { ok: true };
  });
  route("GET", "/api/audit", "device", ({ url }) => {
    const limit = Number(url.searchParams.get("limit") ?? "100");
    return hub.store.listAudit(Number.isFinite(limit) ? limit : 100);
  });
  route("GET", "/api/nodes", "device", () => hub.nodeInfos());
  route("POST", "/api/nodes/:id/remove", "device", ({ params, actor }) => {
    hub.removeNode(decodeURIComponent(params[0]!), actor);
    return { ok: true };
  });
  route("POST", "/api/nodes/join-token", "device", ({ actor }) => {
    const token = hub.store.createJoinToken();
    hub.store.audit(actor, "node.join-token");
    return { token, command: `agentfleet-node join <HUB_URL> ${token}` };
  });
  route("GET", "/api/projects", "device", () => hub.projects());
  route("GET", "/api/tasks", "device", () => hub.store.listTasks());
  route("POST", "/api/tasks", "device", ({ body, actor }) => hub.createTask(body as never, actor));
  route("GET", "/api/tasks/:id", "device", ({ params }) => {
    const task = hub.store.getTask(params[0]!);
    if (!task) throw new HubError(404, "task not found");
    return { task, runs: hub.store.runsForTask(task.id) };
  });
  route("POST", "/api/tasks/:id/cancel", "device", ({ params, actor }) => hub.cancelTask(params[0]!, actor));
  route("POST", "/api/tasks/:id/retry", "device", ({ params, actor }) => hub.retryTask(params[0]!, actor));
  route("GET", "/api/runs/:id", "device", ({ params }) => {
    const run = hub.store.getRun(params[0]!);
    if (!run) throw new HubError(404, "run not found");
    return run;
  });
  route("GET", "/api/runs/:id/events", "device", ({ params, url }) => {
    const after = Number(url.searchParams.get("after") ?? "-1");
    return hub.store.eventsAfter(params[0]!, Number.isFinite(after) ? after : -1);
  });
  route("POST", "/api/runs/:id/input", "device", ({ params, body, actor }) => {
    const { text, e2ee } = InputRequest.parse(body);
    hub.sendInput(params[0]!, text, actor, e2ee);
    return { ok: true };
  });
  route("POST", "/api/runs/:id/approvals/:approvalId", "device", ({ params, body, actor }) => {
    const { optionId, e2ee } = ApprovalDecisionRequest.parse(body);
    hub.resolveApproval(params[0]!, decodeURIComponent(params[1]!), optionId, actor, e2ee);
    return { ok: true };
  });
  route("POST", "/api/runs/:id/interrupt", "device", ({ params, actor }) => {
    hub.interruptRun(params[0]!, actor);
    return { ok: true };
  });
  route("POST", "/api/runs/:id/actions", "device", ({ params, body, actor }) =>
    hub.runAction(params[0]!, RunActionRequest.parse(body).action, actor),
  );

  const server = createServer(async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") return void res.writeHead(204).end();
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const match = routes
        .filter((r) => r.method === req.method)
        .map((r) => ({ r, m: r.pattern.exec(url.pathname) }))
        .find((x) => x.m);
      if (!match) throw new HubError(404, "not found");
      let actor = "anonymous";
      if (match.r.auth === "device") {
        const device = hub.store.deviceByToken(bearer(req) ?? "");
        if (!device) throw new HubError(401, "unauthorized");
        hub.store.touchDevice(device.id);
        actor = `device:${device.id}`;
      }
      const body = req.method === "POST" ? await readJson(req) : undefined;
      const result = await match.r.handler({ req, params: match.m!.slice(1), body, actor, url });
      sendJson(res, 200, result ?? { ok: true });
    } catch (err) {
      if (err instanceof HubError) return sendJson(res, err.status, { error: err.message });
      if (err instanceof z.ZodError) return sendJson(res, 400, { error: "invalid request", issues: err.issues });
      console.error("[hub] unhandled", err);
      sendJson(res, 500, { error: "internal error" });
    }
  });

  // ---- WebSockets ----------------------------------------------------------------
  const nodeWss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  const clientWss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/ws/node") {
      const node = hub.store.nodeByToken(bearer(req) ?? "");
      if (!node) return rejectUpgrade(socket);
      nodeWss.handleUpgrade(req, socket, head, (ws) => attachNode(hub, ws, node.id));
    } else if (url.pathname === "/ws/client") {
      const device = hub.store.deviceByToken(url.searchParams.get("token") ?? bearer(req) ?? "");
      if (!device) return rejectUpgrade(socket);
      hub.store.touchDevice(device.id);
      clientWss.handleUpgrade(req, socket, head, (ws) => attachClient(hub, ws, device.id));
    } else {
      rejectUpgrade(socket, 404);
    }
  });

  server.on("close", () => {
    for (const ws of [...nodeWss.clients, ...clientWss.clients]) ws.terminate();
  });

  return server;
}

function attachNode(hub: Hub, ws: WebSocket, nodeId: string) {
  const conn: NodeConn = {
    send: (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg)),
    close: (code, reason) => ws.close(code, reason),
  };
  hub.nodeConnected(nodeId, conn);
  const alive = keepAlive(ws);
  ws.on("message", (data) => {
    let parsed;
    try {
      parsed = NodeToHub.safeParse(JSON.parse(data.toString()));
    } catch {
      return;
    }
    if (!parsed.success) {
      console.warn(`[hub] invalid node message from ${nodeId}:`, parsed.error.issues[0]);
      return;
    }
    hub.nodeMessage(nodeId, parsed.data);
  });
  ws.on("close", () => {
    clearInterval(alive);
    hub.nodeDisconnected(nodeId, conn);
  });
}

function attachClient(hub: Hub, ws: WebSocket, deviceId: string) {
  const conn: ClientConn = {
    subs: new Set(),
    deviceId,
    send: (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg)),
    close: (code, reason) => ws.close(code, reason),
  };
  hub.addClient(conn);
  const alive = keepAlive(ws);
  ws.on("message", (data) => {
    let parsed;
    try {
      parsed = ClientToHub.safeParse(JSON.parse(data.toString()));
    } catch {
      return conn.send({ type: "error", message: "invalid json" });
    }
    if (!parsed.success) return conn.send({ type: "error", message: "invalid message" });
    const m = parsed.data;
    if (m.type === "subscribe") hub.subscribe(conn, m.runId, m.after);
    else if (m.type === "unsubscribe") conn.subs.delete(m.runId);
    else conn.send({ type: "pong" });
  });
  ws.on("close", () => {
    clearInterval(alive);
    hub.removeClient(conn);
  });
}

/** Ping every 25s; terminate if the previous ping went unanswered (dead mobile connections). */
function keepAlive(ws: WebSocket) {
  let alive = true;
  ws.on("pong", () => (alive = true));
  return setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 25_000);
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : null;
}

function rejectUpgrade(socket: import("node:stream").Duplex, status = 401) {
  socket.write(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Not Found"}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function setCors(res: ServerResponse) {
  // Bearer tokens (no cookies), so a wildcard origin is safe and lets the Expo web build talk to any hub.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HubError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HubError(400, "invalid json");
  }
}
