import { createHighlighter, bundledLanguages, type Highlighter } from "shiki";

const PRIORITY_LANGS = [
  "typescript", "javascript", "tsx", "jsx", "json",
  "python", "rust", "go", "vue", "svelte",
  "java", "kotlin", "ruby", "php",
  "css", "scss", "html", "yaml", "toml", "markdown",
  "bash", "dockerfile", "sql", "graphql",
];

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript", ".tsx": "tsx",
  ".js": "javascript", ".jsx": "jsx",
  ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".rs": "rust",
  ".go": "go", ".vue": "vue",
  ".svelte": "svelte", ".java": "java",
  ".kt": "kotlin", ".kts": "kotlin",
  ".rb": "ruby", ".erb": "ruby",
  ".php": "php",
  ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp",
  ".c": "c", ".h": "c", ".hpp": "cpp",
  ".cs": "csharp", ".swift": "swift",
  ".scala": "scala", ".sc": "scala",
  ".r": "r", ".R": "r",
  ".m": "objective-c", ".mm": "objective-cpp",
  ".sh": "bash", ".zsh": "zsh", ".fish": "fish",
  ".ps1": "powershell", ".psm1": "powershell",
  ".sql": "sql",
  ".graphql": "graphql", ".gql": "graphql",
  ".yaml": "yaml", ".yml": "yaml",
  ".toml": "toml", ".ini": "ini",
  ".md": "markdown", ".mdx": "mdx",
  ".css": "css", ".scss": "scss", ".sass": "sass",
  ".less": "less", ".html": "html", ".htm": "html",
  ".json": "json", ".jsonc": "jsonc",
  "dockerfile": "dockerfile", ".dockerfile": "dockerfile",
};

export class DiffHighlighter {
  private highlighter!: Highlighter;
  private loadedLangs = new Set<string>();
  private theme: string = "github-dark";

  async init(preferDark: boolean = true) {
    this.theme = preferDark ? "github-dark" : "github-light";
    
    this.highlighter = await createHighlighter({
      themes: ["github-dark", "github-light"],
      langs: PRIORITY_LANGS as any[],
    });
    
    PRIORITY_LANGS.forEach((l) => this.loadedLangs.add(l));
  }

  async highlightDiff(filePath: string, diffContent: string): Promise<string> {
    const lines = diffContent.split("\n");
    const lang = this.detectLang(filePath);
    await this.ensureLanguage(lang);
    
    const effectiveLang = this.loadedLangs.has(lang) ? lang : "text";
    let result = '<div class="diff-view">';
    
    let oldLine = 0;
    let newLine = 0;
    
    for (const line of lines) {
      if (line.startsWith("@@")) {
        // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
        const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (match) {
          oldLine = parseInt(match[1]);
          newLine = parseInt(match[3]);
        }
        result += `<div class="hunk-header">${this.escapeHtml(line)}</div>`;
      } else if (line.startsWith("---") || line.startsWith("+++")) {
        result += `<div class="file-header">${this.escapeHtml(line)}</div>`;
      } else if (line.startsWith("-")) {
        const code = line.slice(1);
        const highlighted = await this.highlightCode(code, effectiveLang);
        result += this.renderLine("remove", "-", highlighted, line, oldLine, null);
        oldLine++;
      } else if (line.startsWith("+")) {
        const code = line.slice(1);
        const highlighted = await this.highlightCode(code, effectiveLang);
        result += this.renderLine("add", "+", highlighted, line, null, newLine);
        newLine++;
      } else if (line.startsWith(" ")) {
        const code = line.slice(1);
        const highlighted = await this.highlightCode(code, effectiveLang);
        result += this.renderLine("context", " ", highlighted, line, oldLine, newLine);
        oldLine++;
        newLine++;
      } else if (line === "") {
        // Empty line in diff output between hunks, skip
      } else if (line.startsWith("\\")) {
        result += `<div class="no-newline">${this.escapeHtml(line)}</div>`;
      }
    }
    
    result += "</div>";
    return result;
  }

  private async highlightCode(code: string, lang: string): Promise<string> {
    if (!code) return "";
    
    const html = this.highlighter.codeToHtml(code, {
      lang,
      theme: this.theme,
    });
    
    // Extract content from <code> tag
    const match = html.match(/<code[^>]*>(.*)<\/code>/s);
    return match ? match[1] : this.escapeHtml(code);
  }

  private renderLine(
    type: string, 
    prefix: string, 
    highlightedCode: string, 
    rawLine: string,
    oldLineNum: number | null,
    newLineNum: number | null
  ): string {
    const escapedPrefix = prefix === " " ? "&nbsp;" : this.escapeHtml(prefix);
    const oldNum = oldLineNum != null ? String(oldLineNum) : "";
    const newNum = newLineNum != null ? String(newLineNum) : "";
    return `<div class="diff-line ${type}" data-old-line="${oldNum}" data-new-line="${newNum}" data-content="${this.escapeAttr(rawLine)}">
      <span class="lineno old">${oldNum}</span>
      <span class="lineno new">${newNum}</span>
      <span class="prefix">${escapedPrefix}</span>
      <span class="code">${highlightedCode || "&nbsp;"}</span>
    </div>`;
  }

  private async ensureLanguage(lang: string) {
    if (this.loadedLangs.has(lang) || !(lang in bundledLanguages)) return;
    
    try {
      await this.highlighter.loadLanguage(lang as any);
      this.loadedLangs.add(lang);
    } catch {
      // Ignore load errors, will fallback to text
    }
  }

  private detectLang(path: string): string {
    const lowerPath = path.toLowerCase();
    
    // Check for Dockerfile (no extension)
    if (lowerPath.includes("dockerfile") || lowerPath.endsWith("/dockerfile")) {
      return "dockerfile";
    }
    
    // Check for Makefile
    if (lowerPath.endsWith("makefile") || lowerPath.endsWith("/makefile")) {
      return "makefile";
    }
    
    // Extension based
    const ext = "." + path.split(".").pop()?.toLowerCase();
    return EXT_TO_LANG[ext] || "text";
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  private escapeAttr(str: string): string {
    return this.escapeHtml(str).replace(/\n/g, "&#10;").replace(/\r/g, "&#13;");
  }
}
