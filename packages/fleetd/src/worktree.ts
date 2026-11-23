/** Git worktree lifecycle: one isolated worktree + branch per run. */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { exec } from "./proc.ts";

export interface Worktree {
  path: string;
  branch: string;
  /** Commit sha the worktree was created from (diff base). */
  base: string;
}

export interface DiffSummary {
  unified: string;
  files: number;
  additions: number;
  deletions: number;
}

const MAX_DIFF_BYTES = 512 * 1024;

/**
 * Cache/build artifacts agents commonly leave behind while running tests
 * (e.g. `python3 test.py` writes __pycache__). Excluded from diffs and commits
 * even when the repo has no .gitignore.
 */
export const JUNK_PATHSPECS = [
  ".",
  ":(exclude,glob)**/__pycache__/**",
  ":(exclude,glob)**/*.pyc",
  ":(exclude,glob)**/.pytest_cache/**",
  ":(exclude,glob)**/.DS_Store",
  ":(exclude,glob)**/node_modules/**",
];

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  const r = await exec("git", ["-C", cwd, ...args], { timeoutMs: 120_000, env: env ? { ...process.env, ...env } : undefined });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

export class Worktrees {
  constructor(private root: string) {}

  async create(repoPath: string, project: string, runId: string, baseRef?: string): Promise<Worktree> {
    mkdirSync(this.root, { recursive: true });
    const short = runId.slice(0, 8);
    const branch = `fleet/${short}`;
    const path = join(this.root, `${project.replace(/[^\w.-]/g, "_")}-${short}`);
    const base = (await git(repoPath, ["rev-parse", baseRef ?? "HEAD"])).trim();
    await git(repoPath, ["worktree", "add", "-b", branch, path, base]);
    return { path, branch, base };
  }

  async diff(wt: Worktree): Promise<DiffSummary> {
    // Intent-to-add so brand-new files show up in the diff without staging content.
    await git(wt.path, ["add", "-A", "-N", "--", ...JUNK_PATHSPECS]);
    const numstat = await git(wt.path, ["diff", "--numstat", wt.base, "--", ...JUNK_PATHSPECS]);
    let files = 0;
    let additions = 0;
    let deletions = 0;
    for (const line of numstat.split("\n")) {
      const [a, d] = line.split("\t");
      if (a === undefined || d === undefined) continue;
      files++;
      additions += Number(a) || 0;
      deletions += Number(d) || 0;
    }
    let unified = await git(wt.path, ["diff", wt.base, "--", ...JUNK_PATHSPECS]);
    if (unified.length > MAX_DIFF_BYTES) unified = unified.slice(0, MAX_DIFF_BYTES) + "\n... (diff truncated)\n";
    return { unified, files, additions, deletions };
  }

  async commit(wt: Worktree, message: string): Promise<string> {
    await git(wt.path, ["add", "-A", "--", ...JUNK_PATHSPECS]);
    const staged = await exec("git", ["-C", wt.path, "diff", "--cached", "--quiet"]);
    if (staged.code === 0) return "没有需要提交的改动";
    const email = (await exec("git", ["-C", wt.path, "config", "user.email"])).stdout.trim();
    const env = email
      ? undefined
      : { GIT_AUTHOR_NAME: "AgentFleet", GIT_AUTHOR_EMAIL: "agentfleet@localhost", GIT_COMMITTER_NAME: "AgentFleet", GIT_COMMITTER_EMAIL: "agentfleet@localhost" };
    return git(wt.path, ["commit", "-m", message], env);
  }

  async push(wt: Worktree): Promise<string> {
    const r = await exec("git", ["-C", wt.path, "push", "-u", "origin", wt.branch], { timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`git push failed: ${(r.stderr || r.stdout).trim()}`);
    return (r.stdout + r.stderr).trim();
  }

  async pr(wt: Worktree, title: string, body: string): Promise<{ output: string; url?: string }> {
    const r = await exec("gh", ["pr", "create", "--head", wt.branch, "--title", title, "--body", body], { cwd: wt.path, timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`gh pr create failed: ${(r.stderr || r.stdout).trim()}`);
    const url = r.stdout.match(/https?:\/\/\S+/)?.[0];
    return { output: r.stdout.trim(), url };
  }

  async remove(repoPath: string, wt: Worktree): Promise<string> {
    await git(repoPath, ["worktree", "remove", "--force", wt.path]);
    await exec("git", ["-C", repoPath, "branch", "-D", wt.branch]);
    return `已删除 worktree ${wt.path} 和分支 ${wt.branch}`;
  }
}
