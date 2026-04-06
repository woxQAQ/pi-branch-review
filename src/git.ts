import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface GitFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked";
  added: number;
  deleted: number;
  oldPath?: string;
  isStaged?: boolean;
  isWorkingDir?: boolean;
}

export interface Comment {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  createdAt: number;
}

export interface GitDiagnostics {
  isGitRepo: boolean;
  currentBranch: string;
  baseBranch: string;
  baseBranchExists: boolean;
  commitsAhead: number;
  hasUncommittedChanges: boolean;
  hasUntrackedFiles: boolean;
  workingDirChanges: number;
  stagedChanges: number;
  rawStatOutput: string;
  rawStatusOutput: string;
  error?: string;
}

function execGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    
    child.stdout?.on("data", (data) => stdout += data.toString());
    child.stderr?.on("data", (data) => stderr += data.toString());
    child.on("close", (code) => resolve({ stdout, stderr, code: code || 0 }));
  });
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  const { stdout } = await execGit(["branch", "--show-current"], cwd);
  return stdout.trim() || "(detached HEAD)";
}

export async function getBranches(cwd: string): Promise<string[]> {
  const { stdout } = await execGit(["branch", "-a", "--format=%(refname:short)"], cwd);
  return stdout
    .split("\n")
    .map((b) => b.trim())
    .filter((b) => b && !b.startsWith("HEAD"))
    .map((b) => b.replace(/^remotes\//, ""))
    .filter((b, i, arr) => arr.indexOf(b) === i);
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  const { code } = await execGit(["rev-parse", "--verify", branch], cwd);
  return code === 0;
}

export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const { stdout } = await execGit(["status", "--porcelain"], cwd);
  return stdout.trim().length > 0;
}

export async function hasCommits(cwd: string): Promise<boolean> {
  const { code } = await execGit(["rev-parse", "HEAD"], cwd);
  return code === 0;
}

export async function detectBaseBranch(cwd: string): Promise<string | null> {
  const candidates = ["main", "master", "develop", "dev"];
  const { stdout } = await execGit(["branch", "--list", ...candidates.flatMap((c) => [c, `origin/${c}`])], cwd);
  
  for (const candidate of candidates) {
    if (stdout.includes(candidate) || stdout.includes(`origin/${candidate}`)) {
      return candidate;
    }
  }
  
  try {
    const { stdout: remoteHead } = await execGit(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
    const match = remoteHead.match(/refs\/remotes\/origin\/(.+)$/);
    if (match) return match[1];
  } catch {
    // Ignore
  }
  
  return null;
}

export async function getDiagnostics(cwd: string, baseBranch: string): Promise<GitDiagnostics> {
  const isGitRepo = await hasGitRepo(cwd);
  if (!isGitRepo) {
    return {
      isGitRepo: false,
      currentBranch: "",
      baseBranch,
      baseBranchExists: false,
      commitsAhead: 0,
      hasUncommittedChanges: false,
      hasUntrackedFiles: false,
      workingDirChanges: 0,
      stagedChanges: 0,
      rawStatOutput: "",
      rawStatusOutput: "",
      error: "Not a git repository",
    };
  }

  const currentBranch = await getCurrentBranch(cwd);
  const baseBranchExists = await branchExists(cwd, baseBranch);
  const hasAnyCommits = await hasCommits(cwd);
  
  // Check for uncommitted changes
  const { stdout: statusOutput } = await execGit(["status", "--porcelain"], cwd);
  const statusLines = statusOutput.trim().split("\n").filter(Boolean);
  const hasUncommittedChanges = statusLines.length > 0;
  const hasUntrackedFiles = statusLines.some(line => line.startsWith("??"));
  const workingDirChanges = statusLines.filter(line => 
    line[1] === 'M' || line[1] === 'D' || line.startsWith("??")
  ).length;
  const stagedChanges = statusLines.filter(line => 
    line[0] === 'A' || line[0] === 'M' || line[0] === 'D' || line[0] === 'R'
  ).length;

  // If no commits yet, we can't use HEAD..HEAD syntax
  // We'll review working directory changes instead
  let commitsAhead = 0;
  let rawStatOutput = "";
  let rawStatusOutput = "";

  if (hasAnyCommits && baseBranchExists && currentBranch !== baseBranch) {
    const aheadResult = await execGit(["rev-list", "--count", `${baseBranch}..HEAD`], cwd);
    commitsAhead = parseInt(aheadResult.stdout.trim(), 10) || 0;
  }

  // Build error message
  let error: string | undefined;
  
  if (!hasAnyCommits && !hasUncommittedChanges) {
    error = "No commits and no uncommitted changes. Add some files to review.";
  } else if (!baseBranchExists && currentBranch === baseBranch) {
    // On base branch with no commits - just review working dir
    // This is OK, we'll show working directory changes
  }

  return {
    isGitRepo,
    currentBranch,
    baseBranch,
    baseBranchExists,
    commitsAhead,
    hasUncommittedChanges,
    hasUntrackedFiles,
    workingDirChanges,
    stagedChanges,
    rawStatOutput,
    rawStatusOutput,
    error,
  };
}

export async function getChangedFiles(cwd: string, baseBranch: string): Promise<GitFile[]> {
  const hasAnyCommits = await hasCommits(cwd);
  const currentBranch = await getCurrentBranch(cwd);
  const baseBranchExists = await branchExists(cwd, baseBranch);
  
  const files: GitFile[] = [];

  // 1. Get committed changes (if on different branch and base exists)
  if (hasAnyCommits && baseBranchExists && currentBranch !== baseBranch) {
    const committedFiles = await getCommittedChanges(cwd, baseBranch);
    files.push(...committedFiles);
  }

  // 2. Get staged changes
  const stagedFiles = await getStagedChanges(cwd);
  for (const f of stagedFiles) {
    const existing = files.find(e => e.path === f.path);
    if (existing) {
      existing.isStaged = true;
    } else {
      files.push(f);
    }
  }

  // 3. Get working directory changes
  const workingFiles = await getWorkingDirChanges(cwd);
  for (const f of workingFiles) {
    const existing = files.find(e => e.path === f.path);
    if (existing) {
      existing.isWorkingDir = true;
    } else {
      files.push(f);
    }
  }

  // 4. Get untracked files
  const untrackedFiles = await getUntrackedFiles(cwd);
  files.push(...untrackedFiles);

  return files;
}

async function getCommittedChanges(cwd: string, baseBranch: string): Promise<GitFile[]> {
  const range = `${baseBranch}..HEAD`;
  
  const { stdout: statOutput } = await execGit(
    ["diff", "--stat", range, "--format="],
    cwd
  );
  
  const { stdout: statusOutput } = await execGit(
    ["diff", "--name-status", range],
    cwd
  );
  
  return parseGitOutput(statOutput, statusOutput, false);
}

async function getStagedChanges(cwd: string): Promise<GitFile[]> {
  const { stdout: statOutput } = await execGit(
    ["diff", "--cached", "--stat", "--format="],
    cwd
  );
  
  const { stdout: statusOutput } = await execGit(
    ["diff", "--cached", "--name-status"],
    cwd
  );
  
  const files = parseGitOutput(statOutput, statusOutput, false);
  files.forEach(f => f.isStaged = true);
  return files;
}

async function getWorkingDirChanges(cwd: string): Promise<GitFile[]> {
  const { stdout: statOutput } = await execGit(
    ["diff", "--stat", "--format="],
    cwd
  );
  
  const { stdout: statusOutput } = await execGit(
    ["diff", "--name-status"],
    cwd
  );
  
  const files = parseGitOutput(statOutput, statusOutput, false);
  files.forEach(f => f.isWorkingDir = true);
  return files;
}

async function getUntrackedFiles(cwd: string): Promise<GitFile[]> {
  const { stdout } = await execGit(
    ["ls-files", "--others", "--exclude-standard"],
    cwd
  );
  
  const files: GitFile[] = [];
  for (const path of stdout.split("\n").filter(Boolean)) {
    try {
      const content = readFileSync(resolve(cwd, path), "utf-8");
      const lines = content.split("\n").length;
      
      files.push({
        path,
        status: "untracked",
        added: lines,
        deleted: 0,
        isWorkingDir: true,
      });
    } catch {
      // Skip files we can't read
    }
  }
  
  return files;
}

function parseGitOutput(
  statOutput: string, 
  statusOutput: string,
  isWorkingDir: boolean
): GitFile[] {
  const statusMap: Record<string, GitFile["status"]> = {
    "A": "added",
    "M": "modified",
    "D": "deleted",
    "R": "renamed",
    "C": "copied",
  };
  
  // Parse status
  const fileStatuses = new Map<string, { status: GitFile["status"]; oldPath?: string }>();
  for (const line of statusOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    
    const parts = trimmed.split("\t");
    if (parts.length < 2) continue;
    
    const statusCode = parts[0][0];
    const status = statusMap[statusCode];
    if (!status) continue;
    
    if (statusCode === "R" || statusCode === "C") {
      if (parts.length >= 3) {
        fileStatuses.set(parts[2], { status, oldPath: parts[1] });
      }
    } else {
      fileStatuses.set(parts[1], { status });
    }
  }
  
  // Parse stats
  const files: GitFile[] = [];
  
  for (const line of statOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes("|") === false) continue;
    
    const pipeIndex = trimmed.lastIndexOf("|");
    if (pipeIndex === -1) continue;
    
    const path = trimmed.slice(0, pipeIndex).trim();
    const statPart = trimmed.slice(pipeIndex + 1).trim();
    
    let added = 0;
    let deleted = 0;
    
    if (statPart.includes("Bin")) {
      added = 1;
    } else {
      const changesMatch = statPart.match(/[\+\-]+$/);
      if (changesMatch) {
        const changes = changesMatch[0];
        added = (changes.match(/\+/g) || []).length;
        deleted = (changes.match(/-/g) || []).length;
      }
    }
    
    const fileInfo = fileStatuses.get(path);
    if (fileInfo) {
      files.push({
        path,
        status: fileInfo.status,
        added,
        deleted,
        oldPath: fileInfo.oldPath,
        isWorkingDir,
      });
    }
  }
  
  return files;
}

export async function getFileDiff(
  cwd: string, 
  filePath: string, 
  baseBranch: string
): Promise<string> {
  const hasAnyCommits = await hasCommits(cwd);
  const currentBranch = await getCurrentBranch(cwd);
  const baseBranchExists = await branchExists(cwd, baseBranch);
  
  // Try different sources in order of priority
  
  // 1. Working directory changes
  const { stdout: workingDiff } = await execGit(["diff", "--", filePath], cwd);
  if (workingDiff) return workingDiff;
  
  // 2. Staged changes
  const { stdout: stagedDiff } = await execGit(["diff", "--cached", "--", filePath], cwd);
  if (stagedDiff) return stagedDiff;
  
  // 3. Committed changes
  if (hasAnyCommits && baseBranchExists && currentBranch !== baseBranch) {
    const { stdout: committedDiff } = await execGit(
      ["diff", `${baseBranch}..HEAD`, "--", filePath],
      cwd
    );
    if (committedDiff) return committedDiff;
  }
  
  // 4. Untracked file - read directly and format as diff
  const { stdout: isUntracked } = await execGit(
    ["ls-files", "--others", "--exclude-standard", "--", filePath],
    cwd
  );
  if (isUntracked.trim()) {
    try {
      const content = readFileSync(resolve(cwd, filePath), "utf-8");
      const lines = content.split("\n");
      const lineCount = lines.length;
      const diffLines = lines.map(l => "+" + l).join("\n");
      return `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\nindex 0000000..0000000\n--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lineCount} @@\n${diffLines}`;
    } catch {
      return "";
    }
  }
  
  return "";
}

export async function hasGitRepo(cwd: string): Promise<boolean> {
  const { code } = await execGit(["rev-parse", "--git-dir"], cwd);
  return code === 0;
}
