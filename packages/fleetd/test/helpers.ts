import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FleetEvent } from "@agentfleet/proto";
import type { AdapterContext, ApprovalRequest } from "../src/adapters/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

/** Command line that runs a TS fixture as a real child process. */
export function fixtureCommand(name: "mock-acp-agent" | "mock-codex-app-server") {
  return { command: process.execPath, args: ["--import", tsxLoader, join(here, "fixtures", `${name}.ts`)] };
}

export function tempDir(prefix = "agentfleet-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A throwaway git repo with one commit. */
export function tempRepo(): string {
  const dir = tempDir("agentfleet-repo-");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], {
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return dir;
}

/** Fake adapter context that records events and answers approvals with a callback. */
export function fakeContext(cwd: string, answer: (req: ApprovalRequest) => string | null) {
  const events: FleetEvent[] = [];
  const approvals: ApprovalRequest[] = [];
  const ctx: AdapterContext = {
    cwd,
    emit: (e) => events.push(e),
    requestApproval: async (req) => {
      approvals.push(req);
      return answer(req);
    },
    log: () => {},
  };
  return { ctx, events, approvals };
}

export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 15_000, label = "condition"): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
