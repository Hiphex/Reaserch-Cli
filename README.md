# 🔬 Deep Research CLI

A stylistic command-line tool for deep web research using **Exa Search** and **OpenRouter** for model selection.

![Version](https://img.shields.io/badge/version-1.0.0-purple)

## Features

- 🧠 **Multi-step Research Planning** - AI generates a research plan with sub-questions
- ⚡ **Batch Parallel Searches** - All searches execute simultaneously for speed
- 🎨 **Clean CLI Output** - Minimal sections, spinners, and readable report output
- 🔄 **Streaming Synthesis** - Watch your report generate in real-time
- 📁 **Export Reports** - Save research to markdown files

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### (Optional) Install the `research` command
```bash
npm run build
npm link
```

### 2. Configure API Keys
Option A (recommended): run the setup wizard
```bash
npm run init
```

Option B: copy and edit `.env`
```bash
cp .env.example .env
```

Edit `.env` and add your keys:
```
EXA_API_KEY=your_exa_key
OPENROUTER_API_KEY=your_openrouter_key
DEFAULT_MODEL=moonshotai/kimi-k2-thinking
MODEL_REASONING_EFFORT=medium
```

Optional model params (only set if you want to override defaults):
```
# MODEL_MAX_TOKENS=
# MODEL_TEMPERATURE=
# MODEL_TOP_P=
# MODEL_TOP_K=
```

### 3. Run Research
```bash
npm run search -- "What are the latest advances in battery technology?"
```

### Simplest: start the interactive assistant
```bash
npm start
# then type questions (each one generates a full report)
```

## Usage

### Interactive (recommended)
```bash
research
# or without installing globally:
node dist/index.js
```

Commands inside the assistant:
```text
/report   run a report (alias)
/model    switch models (OpenRouter)
/params   edit model generation params
/settings update defaults (saved to .env)
/trace    toggle tool/activity display
/save     save last report
/history  show recent questions
/sources  show sources from last report
```

### One-off report (non-interactive)
```bash
research search "Your research question"
```

### Specify Model
```bash
research search "Your question" --model anthropic/claude-3.5-sonnet
```

### Save Report to File
```bash
research search "Your question" --output report.md
```

### List Available Models
```bash
research models
```

Select and save a default model:
```bash
research models --select
```

Show model details/params:
```bash
research models --details --filter claude
```

### Customize UI / Output
```bash
research init
# advanced setup:
research init --advanced
# or override per run:
research search "..." --ui fancy
research search "..." --no-stream --render terminal
research agent --ui minimal --reasoning on
```

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│  1. PLANNING PHASE                                      │
│     • AI analyzes your query                            │
│     • Generates 3-6 focused sub-questions               │
│     • Creates optimized search queries                  │
├─────────────────────────────────────────────────────────┤
│  2. EXECUTION PHASE                                     │
│     • All searches run in parallel (batch)              │
│     • Exa's deep semantic search finds sources          │
│     • Extracts highlights and summaries                 │
├─────────────────────────────────────────────────────────┤
│  3. SYNTHESIS PHASE                                     │
│     • LLM combines all findings                         │
│     • Streams a comprehensive report                    │
│     • Includes citations to sources                     │
└─────────────────────────────────────────────────────────┘
```

## Project Structure

```
deep-research-cli/
├── src/
│   ├── index.ts              # CLI entry point
│   ├── config.ts             # Configuration loader
│   ├── clients/
│   │   ├── exa.ts            # Exa Search API client
│   │   └── openrouter.ts     # OpenRouter API client
│   ├── research/
│   │   ├── planner.ts        # Research plan generation
│   │   ├── executor.ts       # Parallel search execution
│   │   ├── synthesizer.ts    # Report synthesis
│   │   └── prompts.ts        # System prompts
│   └── ui/
│       ├── theme.ts          # Colors, gradients, icons
│       └── components.ts     # UI components
├── package.json
├── tsconfig.json
└── .env.example
```

## Getting API Keys

- **Exa API Key**: [exa.ai](https://exa.ai) - Sign up for API access
- **OpenRouter API Key**: [openrouter.ai](https://openrouter.ai) - Create account and generate key

## License

MIT
