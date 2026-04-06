import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { open, type GlimpseWindow } from "./glimpse.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DiffHighlighter } from "./highlighter.js";
import {
  getBranches,
  getChangedFiles,
  getCurrentBranch,
  getFileDiff,
  detectBaseBranch,
  hasGitRepo,
  getDiagnostics,
  hasUncommittedChanges,
  type GitFile,
  type Comment,
} from "./git.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ReviewState {
  baseBranch: string;
  currentBranch: string;
  files: GitFile[];
  comments: Comment[];
  currentFile: string | null;
}

export default function (pi: ExtensionAPI) {
  let window: GlimpseWindow | null = null;
  let highlighter: DiffHighlighter | null = null;
  let state: ReviewState = {
    baseBranch: "main",
    currentBranch: "",
    files: [],
    comments: [],
    currentFile: null,
  };

  const template = readFileSync(
    join(__dirname, "ui", "template.html"),
    "utf-8",
  );

  pi.registerCommand("review", {
    description:
      "Open code review UI for current branch or uncommitted changes",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Code review requires interactive mode", "error");
        return;
      }

      const cwd = ctx.cwd;

      if (!(await hasGitRepo(cwd))) {
        ctx.ui.notify("Not a git repository", "error");
        return;
      }

      // Get base branch first
      const detectedBase = await detectBaseBranch(cwd);
      state.baseBranch = detectedBase || "main";

      // Run diagnostics
      const diagnostics = await getDiagnostics(cwd, state.baseBranch);

      // Check for any changes to review
      if (
        !diagnostics.hasUncommittedChanges &&
        diagnostics.commitsAhead === 0
      ) {
        ctx.ui.notify(
          "No changes to review (no uncommitted changes and no commits ahead)",
          "info",
        );
        return;
      }

      // Init highlighter
      if (!highlighter) {
        highlighter = new DiffHighlighter();
        await highlighter.init(true);
      }

      // Get git info
      state.currentBranch = diagnostics.currentBranch;
      state.files = await getChangedFiles(cwd, state.baseBranch);
      state.comments = [];
      state.currentFile = null;

      if (state.files.length === 0) {
        ctx.ui.notify("No files found to review", "info");
        return;
      }

      // Build title showing what we're reviewing
      let title = `Code Review: ${state.currentBranch}`;
      if (diagnostics.hasUncommittedChanges && diagnostics.commitsAhead > 0) {
        title += ` (+${diagnostics.commitsAhead} commits + uncommitted)`;
      } else if (diagnostics.hasUncommittedChanges) {
        title += ` (uncommitted changes)`;
      } else {
        title += ` → ${state.baseBranch}`;
      }

      // Open window
      window = open(template, {
        width: 1400,
        height: 900,
        title,
      });

      window.on("message", async (data) => {
        switch (data.type) {
          case "init": {
            const branches = await getBranches(cwd);
            window?.send(`
              window.glimpse.onMessage({
                type: 'init',
                currentBranch: ${JSON.stringify(state.currentBranch)},
                baseBranch: ${JSON.stringify(state.baseBranch)},
                branches: ${JSON.stringify(branches)},
                files: ${JSON.stringify(state.files)},
                comments: ${JSON.stringify(state.comments)}
              });
            `);
            break;
          }

          case "selectFile": {
            const filePath = data.file;
            state.currentFile = filePath;
            const diff = await getFileDiff(cwd, filePath, state.baseBranch);
            const highlighted = await highlighter!.highlightDiff(
              filePath,
              diff,
            );
            window?.send(`
              window.glimpse.onMessage({
                type: 'diff',
                file: ${JSON.stringify(filePath)},
                html: ${JSON.stringify(highlighted)}
              });
            `);
            break;
          }

          case "changeBranch": {
            state.baseBranch = data.branch;
            state.files = await getChangedFiles(cwd, state.baseBranch);
            state.comments = [];
            window?.send(`
              window.glimpse.onMessage({
                type: 'init',
                currentBranch: ${JSON.stringify(state.currentBranch)},
                baseBranch: ${JSON.stringify(state.baseBranch)},
                branches: ${JSON.stringify(await getBranches(cwd))},
                files: ${JSON.stringify(state.files)},
                comments: []
              });
            `);
            break;
          }

          case "addComment": {
            const comment: Comment = {
              id: generateId(),
              file: data.comment.file,
              startLine: data.comment.startLine,
              endLine: data.comment.endLine,
              text: data.comment.text,
              createdAt: Date.now(),
            };
            state.comments.push(comment);
            window?.send(`
              window.glimpse.onMessage({
                type: 'comments',
                comments: ${JSON.stringify(state.comments)}
              });
            `);
            break;
          }

          case "deleteComment": {
            state.comments.splice(data.index, 1);
            window?.send(`
              window.glimpse.onMessage({
                type: 'comments',
                comments: ${JSON.stringify(state.comments)}
              });
            `);
            break;
          }

          case "refresh": {
            state.files = await getChangedFiles(cwd, state.baseBranch);
            window?.send(`
              window.glimpse.onMessage({
                type: 'init',
                currentBranch: ${JSON.stringify(state.currentBranch)},
                baseBranch: ${JSON.stringify(state.baseBranch)},
                branches: ${JSON.stringify(await getBranches(cwd))},
                files: ${JSON.stringify(state.files)},
                comments: ${JSON.stringify(state.comments)}
              });
            `);
            break;
          }

          case "submit": {
            const prompt = buildReviewPrompt(state, diagnostics);
            pi.sendUserMessage(prompt);
            window?.close();
            window = null;
            break;
          }
        }
      });

      window.on("closed", () => {
        window = null;
      });
    },
  });
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 11);
}

function buildReviewPrompt(
  state: ReviewState,
  diagnostics: {
    hasUncommittedChanges: boolean;
    commitsAhead: number;
    currentBranch: string;
  },
): string {
  const hasCommits = diagnostics.commitsAhead > 0;
  const hasUncommitted = diagnostics.hasUncommittedChanges;

  if (state.comments.length === 0) {
    let intro = `Please review the following changes`;
    if (hasCommits && hasUncommitted) {
      intro += ` (${diagnostics.commitsAhead} commits ahead + uncommitted changes)`;
    } else if (hasUncommitted) {
      intro += ` (uncommitted changes)`;
    }
    intro += `:\n\n`;

    return (
      intro +
      `Files changed:
${state.files
  .map((f) => {
    const badges = [];
    if (f.isStaged) badges.push("staged");
    if (f.isWorkingDir) badges.push("modified");
    const badge = badges.length > 0 ? ` [${badges.join(", ")}]` : "";
    return `- ${f.path}${badge} (+${f.added}/-${f.deleted})`;
  })
  .join("\n")}

No specific comments were added. Please review the code and suggest improvements.`
    );
  }

  const byFile = new Map<string, Comment[]>();
  for (const c of state.comments) {
    const list = byFile.get(c.file) || [];
    list.push(c);
    byFile.set(c.file, list);
  }

  let prompt = `Please review the following code review comments and make the requested changes.

`;

  if (hasCommits && hasUncommitted) {
    prompt += `Changes: ${diagnostics.commitsAhead} commits ahead + uncommitted changes\n`;
  } else if (hasUncommitted) {
    prompt += `Changes: Uncommitted changes\n`;
  } else {
    prompt += `Branch: ${diagnostics.currentBranch}\n`;
  }

  for (const [file, comments] of byFile) {
    prompt += `\n## File: ${file}\n\n`;
    for (const c of comments) {
      const location =
        c.startLine === c.endLine
          ? `Line ${c.startLine}`
          : `Lines ${c.startLine}-${c.endLine}`;
      prompt += `### ${location}\n\n${c.text}\n\n`;
    }
  }

  prompt += `\nPlease address all the comments above. If you have questions about any comment, ask for clarification.`;

  return prompt;
}
