# AGENTS.md

This file provides guidance for AI coding agents working on this repository.

## Project Overview

**vscode-erlab** is a VS Code extension for working with xarray objects (DataArray, Dataset, DataTree) and the [ERLab](https://github.com/kmnhan/erlabpy) Python package in Jupyter Notebooks. It provides hover actions, tree views, and magic commands for ARPES (Angle-Resolved Photoemission Spectroscopy) data analysis workflows.

## Tech Stack

- **Language:** TypeScript
- **Runtime:** VS Code Extension API
- **Build:** TypeScript compiler (`tsc`)
- **Linting:** ESLint with typescript-eslint
- **Testing:**
  - Unit tests: Mocha (no VS Code required)
  - Integration/E2E tests: `@vscode/test-cli` + `@vscode/test-electron`
- **Python Integration:** Jupyter kernel communication for xarray object inspection

## Project Structure

```text
src/
├── extension.ts          # Extension entry point (activate/deactivate)
├── commands/             # VS Code command implementations
│   ├── index.ts          # Command registration
│   ├── args.ts           # Command argument parsing
│   └── magicInvocation.ts # IPython magic execution
├── features/
│   ├── xarray/           # xarray Objects panel feature
│   │   ├── service.ts    # Core service for fetching xarray objects from kernel
│   │   ├── formatting.ts # Display formatting utilities
│   │   ├── types.ts      # TypeScript interfaces (XarrayEntry, XarrayObjectType)
│   │   ├── pythonSnippets.ts # Python code for object detection
│   │   └── views/        # Tree view and detail panel UI
│   └── hover/            # Hover provider for notebooks
├── kernel/               # Jupyter kernel communication
│   ├── kernelClient.ts   # Kernel execution and result parsing
│   └── types.ts          # Kernel-related types
├── notebook/             # Notebook utilities
│   ├── notebookUris.ts   # URI handling for notebook cells
│   └── definitionSearch.ts # Variable definition search
├── python/               # Python code generation
│   └── identifiers.ts    # Python identifier validation
└── test/
    ├── extension.test.ts # Integration + E2E tests (VS Code required)
    └── unit/             # Pure unit tests (no VS Code)
```

If you change the layout or add new files, update this Project Structure section.

## Key Commands

```bash
npm run compile      # Compile TypeScript
npm run watch        # Watch mode compilation
npm run lint         # Run ESLint
npm run test         # Run all VS Code integration tests
npm run test:unit    # Run unit tests only (fast, no VS Code)
npm run test:e2e     # Run E2E tests with Python/Jupyter
npm run test:e2e:setup   # Create cached Python venv with uv
npm run test:e2e:cached  # Run E2E tests using cached venv
```

## Testing

### Unit Tests

Located in `src/test/unit/`. These test pure functions without VS Code dependencies:

- `formatting.test.ts` - xarray label formatting
- `identifiers.test.ts` - Python identifier validation
- `kernelParsing.test.ts` - Kernel response parsing
- `commandArgs.test.ts` - Command argument parsing
- `magicInvocation.test.ts` - Magic command generation

Run with: `npm run test:unit`

### Integration Tests

Located in `src/test/extension.test.ts`. These require VS Code test infrastructure:

- Extension activation
- Command registration
- Hover provider behavior

Run with: `npm run test`

### E2E Tests

Gated behind `ERLAB_E2E=1` environment variable. Require Python with `erlab`, `pyqt6`, and `ipykernel` packages.

**Local development with caching:**

```bash
npm run test:e2e:setup    # One-time: create .venv-e2e/ with uv
npm run test:e2e:cached   # Use cached venv for fast iteration
```

**Without caching:**

```bash
npm run test:e2e          # Creates temp venv each time (slow)
```

## Environment Variables

| Variable | Purpose |
| -------- | ------- |
| `ERLAB_E2E` | Set to `1` to enable E2E tests |
| `ERLAB_E2E_VENV` | Path to pre-built Python venv (skips venv creation) |
| `PYTHON` | Python binary to use for venv creation (default: `python3`) |

## CI/CD

- **CI workflow** (`.github/workflows/ci.yaml`): Runs on push/PR, uses uv for cached Python deps
- **Release workflow** (`.github/workflows/release.yaml`): Publishes to VS Code Marketplace, Open VSX, and GitHub Releases on new tag

## Extension Dependencies

This extension requires `ms-toolsai.jupyter` (Jupyter extension) to be installed.

## Code Conventions

- Use TypeScript strict mode
- Prefix internal commands with `erlab.`
- xarray panel commands use `erlab.xarray.*` namespace
- Use `vscode.commands.registerCommand` for command registration
- Kernel communication goes through `KernelClient` class
- Python code snippets are defined in `pythonSnippets.ts`
- Update `README.md` when adding or modifying user-facing features, commands, or actions
- When adding new commands, always add them to both `package.json` AND the Commands section in `README.md`

### Changelog Requirements

**Always add a `CHANGELOG.md` entry when making user-visible changes.** This includes:

- New features or UI elements (icons, tree items, panels, hover actions)
- Changes to existing behavior users can observe
- New commands or settings
- Bug fixes that affect user experience

Do NOT add changelog entries for:

- Internal refactoring with no visible impact
- Test-only changes
- Documentation-only changes (unless README feature docs)

If `CHANGELOG.md` lacks a `## [Unreleased]` section, create it before adding the entry.

## Common Tasks

### Adding a new command

1. Define command in `package.json` under `contributes.commands`
2. Add menu entries if needed under `contributes.menus`
3. Implement handler in `src/commands/`
4. Register in `src/commands/index.ts`

### Adding a new test

- Unit test: Create `*.test.ts` in `src/test/unit/`
- Integration test: Add to `src/test/extension.test.ts`

### Modifying Python snippets

Edit `src/features/xarray/pythonSnippets.ts` - these are executed in the Jupyter kernel.
