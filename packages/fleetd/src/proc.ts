import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a command to completion (no shell). Never throws for non-zero exit. */
export function exec(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      return resolve({ code: -1, stdout: "", stderr: String(err) });
    }
    let stdout = "";
    let stderr = "";
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin!.end(opts.input);
    else child.stdin!.end();
  });
}

/** Spawn a long-lived agent process with piped stdio; stderr is forwarded line-by-line to `onStderr`. */
export function spawnAgent(cmd: string, args: string[], opts: SpawnOptions & { onStderr?: (line: string) => void }): ChildProcess {
  const child = spawn(cmd, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  child.stderr?.on("data", (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trimEnd();
      buf = buf.slice(i + 1);
      if (line) opts.onStderr?.(line);
    }
  });
  return child;
}

export async function commandExists(cmd: string): Promise<boolean> {
  if (cmd.includes("/")) return (await exec("test", ["-x", cmd])).code === 0;
  return (await exec("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", cmd], { timeoutMs: 3000 })).code === 0;
}

export async function versionOf(cmd: string, args = ["--version"]): Promise<string | null> {
  const r = await exec(cmd, args, { timeoutMs: 8000 });
  if (r.code !== 0) return null;
  const line = (r.stdout || r.stderr).trim().split("\n")[0] ?? "";
  return line.match(/\d+\.\d+[\w.\-+]*/)?.[0] ?? (line || null);
}

export function killTree(child: ChildProcess, graceMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const t = setTimeout(() => child.kill("SIGKILL"), graceMs);
    child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Agent stderr is mostly noise (debug); lines that look like errors are surfaced to the phone as warnings. */
export function classifyStderr(line: string): { level: "debug" | "warn"; text: string } {
  const text = line.replace(ANSI, "");
  return { level: /\bERROR\b|\bFATAL\b|\bpanic(ked)?\b/.test(text) ? "warn" : "debug", text };
}
