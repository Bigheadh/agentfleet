import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACTION_IDENTIFIER,
  foregroundBehavior,
  parsePushData,
  precheckPush,
  resolveProjectId,
  routeForNotificationResponse,
  routeForPushData,
  type NotificationResponseLike,
} from "./pushData";

const response = (data: unknown, actionIdentifier = DEFAULT_ACTION_IDENTIFIER): NotificationResponseLike => ({
  actionIdentifier,
  notification: { request: { identifier: "n1", content: { data } } },
});

describe("push data helpers", () => {
  it("parses valid push payloads and rejects others", () => {
    expect(parsePushData({ kind: "approval", taskId: "t1", runId: "r1" })).toEqual({ kind: "approval", taskId: "t1", runId: "r1" });
    expect(parsePushData({ kind: "review", taskId: "t2" })).toEqual({ kind: "review", taskId: "t2" });
    expect(parsePushData({ kind: "failed", taskId: "" })).toBeNull();
    expect(parsePushData({ kind: "other", taskId: "t1" })).toBeNull();
    expect(parsePushData({ kind: "approval" })).toBeNull();
    expect(parsePushData(null)).toBeNull();
    expect(parsePushData(undefined)).toBeNull();
    expect(parsePushData("x")).toBeNull();
  });

  it("routes to the task detail screen", () => {
    expect(routeForPushData({ kind: "failed", taskId: "abc" })).toBe("/tasks/abc");
    expect(routeForPushData({ kind: "failed", taskId: "a/b c" })).toBe("/tasks/a%2Fb%20c");
  });

  it("routes notification taps only for the default action and valid data", () => {
    expect(routeForNotificationResponse(response({ kind: "approval", taskId: "t9", runId: "r" }))).toBe("/tasks/t9");
    expect(routeForNotificationResponse(response({ kind: "approval", taskId: "t9" }, "custom.action"))).toBeNull();
    expect(routeForNotificationResponse(response({ foo: 1 }))).toBeNull();
    expect(routeForNotificationResponse(response(undefined))).toBeNull();
    expect(routeForNotificationResponse(null)).toBeNull();
    expect(routeForNotificationResponse(undefined)).toBeNull();
  });

  it("plays a sound in the foreground only for approvals", () => {
    expect(foregroundBehavior({ kind: "approval", taskId: "t" })).toEqual({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    });
    expect(foregroundBehavior({ kind: "review", taskId: "t" }).shouldPlaySound).toBe(false);
    expect(foregroundBehavior({}).shouldShowBanner).toBe(true);
  });

  it("resolves the EAS project id", () => {
    expect(resolveProjectId({ extra: { eas: { projectId: "p1" } } }, { projectId: "p2" })).toBe("p1");
    expect(resolveProjectId({ extra: {} }, { projectId: "p2" })).toBe("p2");
    expect(resolveProjectId({ extra: { eas: { projectId: "  " } } }, null)).toBeNull();
    expect(resolveProjectId(null, undefined)).toBeNull();
    expect(resolveProjectId({ extra: { eas: { projectId: 42 } } }, {})).toBeNull();
  });

  it("prechecks the environment", () => {
    const base = { platform: "ios", isDevice: true, executionEnvironment: "standalone", projectId: "p" };
    expect(precheckPush(base)).toEqual({ ok: true, projectId: "p" });
    expect(precheckPush({ ...base, platform: "web" })).toEqual({ ok: false, reason: "web" });
    expect(precheckPush({ ...base, isDevice: false })).toEqual({ ok: false, reason: "simulator" });
    expect(precheckPush({ ...base, platform: "android", executionEnvironment: "storeClient" })).toEqual({
      ok: false,
      reason: "expoGoAndroid",
    });
    expect(precheckPush({ ...base, executionEnvironment: "storeClient" })).toEqual({ ok: true, projectId: "p" });
    expect(precheckPush({ ...base, projectId: null })).toEqual({ ok: false, reason: "noProjectId" });
  });
});
