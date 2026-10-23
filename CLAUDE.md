# Money in Order

Personal zero-based budgeting PWA (Preact + Vite + TypeScript), hosted on Netlify with an encrypted sync function.

## Workflow rules

- Always merge finished work into `main` and push it. `main` is what's deployed.
- Every push to `main` is a production deploy, and each deploy uses Netlify build credits. Push `main` once, when the
  session's work is done (or when the user asks), not after each milestone or fix. Commit locally as often as you like;
  batch several tasks into one push. This overrides any general "push after each milestone" rule.
- After pushing `main`, make sure the Netlify site `money-in-order` (site id `64c8d96a-50c3-4fac-9c6a-dd5c69730fcd`) is updated:
  if the repo is linked for continuous deployment this happens on push; otherwise deploy with the Netlify MCP `deploy-site` operation.
- Before pushing: `npm run typecheck && npm test && npm run build`.
- The repo is public: never commit real financial data (amounts, balances, exports).

## Product principles

- Less is more. Show only what the moment needs; no eyebrow labels, helper footers or explanatory text that restates the obvious.
- Same visual language everywhere: round pill pickers instead of selects and tables, one-tap choices, inline editing.
- Phone first, but every feature must also work well with mouse and keyboard on a laptop.
- Light, neutral background; key numbers get the yellow marker highlight.

## Autonomous Execution & Token Efficiency Rules

- **Zero sleep-polling loops**: never run `sleep N; cat /tmp/...` loops to check on background sub-agents. Wait for background tasks synchronously or via completion notifications so the main thread does not wake up repeatedly.
- **Clean sub-agent isolation**: use parallel sub-agents when they speed up work, but always branch worktrees from current `HEAD`, assign strict non-overlapping file boundaries to prevent duplicate edits, and keep worktrees outside `tests/` (or exclude them in the test config) so `npm test` never runs duplicate suites.
- **Hybrid model routing**: use Opus where deep reasoning matters (architecture, design and math audits, root-cause debugging) and route implementation fixers, flow tests, and git/deploy orchestration to Sonnet.
- **Uninterrupted autonomous runs with git checkpoints**: do not pause to ask for human review between milestones unless genuinely blocked. Commit after each completed milestone so progress is crash-safe, but push `main` only once at the end (see Workflow rules: every push deploys).
- **Signal-only test logs**: run the full test and typecheck suites after merging a batch, and suppress verbose passing output so only failures enter the context window.
