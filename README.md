# Pi Code Review Extension

A native code review UI for Pi using Glimpse WebView. Compare current branch with base branch, annotate lines with comments, and submit as prompt.

## Features

- **Branch comparison** - Compare current branch with any base branch (main/master/develop/etc)
- **File browser** - List all changed files with status indicators
- **Line annotations** - Click or drag to select lines and add comments
- **Syntax highlighting** - Powered by Shiki.js
- **One-click submit** - Send all comments as a prompt to the LLM

## Installation

### 1. Install dependencies

```bash
cd .pi-extensions/code-review
npm install
```

### 2. Build native binary (if needed)

```bash
# macOS
npm run build:macos

# Linux
npm run build:linux

# Windows
npm run build:windows
```

### 3. Load the extension

**Option A: Project-local (recommended)**

The extension is already in `.pi-extensions/code-review/`. Just run:

```bash
pi -e ./.pi-extensions/code-review/index.ts
```

Or add to your project's `.pi/settings.json`:

```json
{
  "extensions": ["./.pi-extensions/code-review"]
}
```

**Option B: Global install**

Copy to global extensions folder:

```bash
cp -r .pi-extensions/code-review ~/.pi/agent/extensions/
```

Then run `pi` normally.

## Usage

### Command

```
/review
```

Opens the code review window.

### Tool

The LLM can also open the review UI:

```
Can you help me review the changes in this branch?
```

The agent will call `open_code_review` tool.

## UI Guide

| Action | How |
|--------|-----|
| Select lines | Click a line, then Shift+click another line to select range |
| Add comment | Select lines → type in popup → Save |
| Delete comment | Click "Delete" in right panel |
| Change base branch | Use dropdown in toolbar |
| Submit review | Click "Submit Review" button |

## File Structure

```
.pii-extensions/code-review/
├── index.ts           # Extension entry point
├── git.ts             # Git operations
├── highlighter.ts     # Shiki.js integration
├── ui/
│   └── template.html  # WebView UI
└── package.json       # Dependencies
```

## Requirements

- Pi coding agent (interactive mode)
- Node.js 18+
- Git repository
- Glimpse native binary (auto-built on install)

## Troubleshooting

**Window doesn't open**
- Make sure you're in interactive mode (not `-p` or JSON mode)
- Check that Glimpse binary is built: `npm run build`

**No syntax highlighting**
- Check Shiki is installed: `npm list shiki`
- Some languages may not be supported (falls back to plain text)

**Git errors**
- Ensure you're in a git repository
- Check that `git` is in PATH

## License

MIT
