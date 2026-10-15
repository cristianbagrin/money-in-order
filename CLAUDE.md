# Money in Order

Personal zero-based budgeting PWA (Preact + Vite + TypeScript), hosted on Netlify with an encrypted sync function.

## Workflow rules

- Always merge finished work into `main` and push it. `main` is what's deployed.
- After pushing `main`, make sure the Netlify site `money-in-order` (site id `64c8d96a-50c3-4fac-9c6a-dd5c69730fcd`) is updated:
  if the repo is linked for continuous deployment this happens on push; otherwise deploy with the Netlify MCP `deploy-site` operation.
- Before pushing: `npm run typecheck && npm test && npm run build`.
- The repo is public: never commit real financial data (amounts, balances, exports).

## Product principles

- Less is more. Show only what the moment needs; no eyebrow labels, helper footers or explanatory text that restates the obvious.
- Same visual language everywhere: round pill pickers instead of selects and tables, one-tap choices, inline editing.
- Phone first, but every feature must also work well with mouse and keyboard on a laptop.
- Light, neutral background; key numbers get the yellow marker highlight.
