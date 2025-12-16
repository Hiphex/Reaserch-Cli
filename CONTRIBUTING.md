# Contributing to Deep Research CLI

Thank you for your interest in contributing! This guide will help you get started.

## Development Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/YOUR_USERNAME/deep-research-cli.git
   cd deep-research-cli
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up API keys**
   ```bash
   npm run init
   ```

4. **Run in development mode**
   ```bash
   npm run dev
   ```

## Code Style

- Use TypeScript for all source files
- Follow existing code patterns and naming conventions
- Keep functions focused and well-documented
- Use meaningful variable and function names

## Making Changes

1. Create a new branch for your feature or fix
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes and test them
   ```bash
   npm run build
   npm test
   ```

3. Commit with a descriptive message
   ```bash
   git commit -m "feat: add new feature description"
   ```

## Pull Requests

- Provide a clear description of what your PR does
- Reference any related issues
- Ensure the build passes
- Keep PRs focused on a single change

## Reporting Issues

When reporting issues, please include:
- Your Node.js version (`node --version`)
- Your operating system
- Steps to reproduce the issue
- Expected vs actual behavior
- Any error messages

## Questions?

Feel free to open an issue for questions or discussions about the project.
