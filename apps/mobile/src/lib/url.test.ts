import { describe, expect, it } from "vitest";
import { PairingPayload } from "@agentfleet/proto";
import { liveSocketUrl, normalizeHubUrl, parsePairingQr } from "./url";

describe("url helpers", () => {
  it("normalizes hub urls", () => {
    expect(normalizeHubUrl("hub.local:8080/")).toBe("http://hub.local:8080");
    expect(normalizeHubUrl(" https://Fleet.example.com/base/ ")).toBe("https://Fleet.example.com/base");
    expect(normalizeHubUrl("http://192.168.1.5:7070")).toBe("http://192.168.1.5:7070");
    expect(normalizeHubUrl("http://[::1]:7070")).toBe("http://[::1]:7070");
    expect(normalizeHubUrl("ftp://x")).toBeNull();
    expect(normalizeHubUrl("")).toBeNull();
    expect(normalizeHubUrl("http://bad host")).toBeNull();
  });

  it("builds the live socket url", () => {
    expect(liveSocketUrl("https://h.example/base", "a b")).toBe("wss://h.example/base/ws/client?token=a%20b");
    expect(liveSocketUrl("http://h:1", "t")).toBe("ws://h:1/ws/client?token=t");
  });

  it("parses pairing QR payloads compatible with the proto schema", () => {
    const payload = { v: 1, hub: "http://10.0.0.2:7070/", code: "ABCD-1234", name: "home" };
    expect(PairingPayload.safeParse(payload).success).toBe(true);
    expect(parsePairingQr(JSON.stringify(payload))).toEqual({ hub: "http://10.0.0.2:7070", code: "ABCD-1234", name: "home" });
    expect(parsePairingQr("https://example.com")).toBeNull();
    expect(parsePairingQr(JSON.stringify({ ...payload, v: 2 }))).toBeNull();
    expect(parsePairingQr(JSON.stringify({ ...payload, code: "" }))).toBeNull();
  });
});
