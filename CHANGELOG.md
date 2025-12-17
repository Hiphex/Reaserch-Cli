# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2025-12-17

### Added
- Cost estimation flags (`--estimate`, `--dry-run`) to preview research costs using live OpenRouter pricing and Exa search assumptions before executing searches.
- Node.js version preflight to enforce Node 22+ with a clear upgrade prompt.
- Configurable research guardrails for sub-agents (search rounds, expanded URLs, and source size caps) with sensible defaults and hard maximums.
- Optional throttling controls for reasoning summarization without hardcoded limits unless explicitly set.

### Fixed
- Cost estimates now rely on dynamic OpenRouter model pricing instead of static rates for improved accuracy.

## [1.0.0] - 2024-12-15

### Added
- Interactive deep-research agent with automatic reasoning and web search
- Multi-step research planning with AI-generated sub-questions
- Parallel batch searches using Exa Search API
- Real-time streaming synthesis with OpenRouter models
- Model selection and parameter customization
- Report export to markdown files
- Interactive commands: `/model`, `/params`, `/trace`, `/save`, `/history`, `/sources`
- Setup wizard for API key configuration
- Multiple UI modes: minimal, fancy, plain
- Support for reasoning models with configurable effort levels
- Provider routing and fallback options

### Features
- 🧠 Multi-step Research Planning - AI generates a research plan with sub-questions
- ⚡ Batch Parallel Searches - All searches execute simultaneously for speed
- 🎨 Clean CLI Output - Minimal sections, spinners, and readable report output
- 🔄 Streaming Synthesis - Watch your report generate in real-time
- 📁 Export Reports - Save research to markdown files
