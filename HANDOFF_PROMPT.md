# CheckVar 2.0 — Session Handoff Prompt

Copy the prompt below into a new Codex session.

---

You are continuing an existing Next.js hackathon prototype called **CheckVar 2.0**. Work from the existing project; do not recreate it from scratch.

## Source of truth

- Project folder: `/Users/bao/Documents/Codex/2026-07-11/main-feature-d-ng-social-listening/outputs/scamdna-demo`
- Local URL: `http://127.0.0.1:3000`
- This folder is **not a Git repository**.
- Read the project `AGENTS.md` and `/Users/bao/.codex/memories/extensions/ad_hoc/notes/2026-06-22T16-15-00-ai-critical-path-workflow.md` before editing.
- Before changing code, inspect the real files and check whether port 3000 is already serving this exact folder. Do not kill a server belonging to another worktree/project.

## Product context

CheckVar originally checked fake news and scam calls. CheckVar 2.0 expands into banking protection.

Customer flow:

1. A customer pastes or drops a suspicious screenshot, QR, URL, phone number, or message.
2. CheckVar compares it with previously collected scam/social-listening intelligence.
3. It explains related evidence and campaign links, even when scammers change phone numbers, accounts, URLs, or wording.
4. It tells the customer to stop transferring money, avoid installing apps, and contact the bank through an official channel.
5. With consent, the customer can send a privacy-redacted report to the bank.

Bank-side concept: social-listening signals and customer reports are clustered into scam campaigns. Fraud analysts confirm relationships and export evidence to SOC/takedown teams through API, webhook, or CSV. The current prototype focuses on the customer-facing surface.

The product must create **evidence-backed friction before money leaves the user**. Do not reduce it to a generic chatbot or a simple risk-score checker.

## Current selected design

- Premium minimal fintech aesthetic.
- Near-black background, white text, exact accent `#DB676D`.
- All user-facing copy is English.
- No header bar.
- Centered main title: `CHECKVAR 2.0`.
- Subtitle: `PROTECT EVERY TRANSFER.`
- Large rounded evidence capsule is the main CTA.
- Smooth horizontal red signal wave runs behind the CTA.
- The wave is rendered from code with React Three Fiber/Three.js, not from a raster image.
- Avoid brutalism, terminal panels, perspective grids, dashboard cards, excessive icons, long copy, and generic cyber-security decoration.
- Preserve reduced-motion support and mobile responsiveness.

Current visual evidence:

- Desktop: `qa-coded-wave-final.png`
- Mobile: `qa-coded-wave-mobile.png`
- QA history: `design-qa.md`

## Important code

- `src/App.jsx`: complete idle → scanning → result → anonymous-report flow and demo data.
- `src/SignalWave.jsx`: React Three Fiber signal-wave implementation.
- `src/styles.css`: design system, landing, result, report modal, responsive rules.
- `app/page.jsx`: Next.js page entry.
- `app/layout.jsx`: metadata and document shell.
- `package.json`: Next.js, React 19, Motion, Three.js, React Three Fiber, Drei and Phosphor dependencies.

Raster experiments still exist under `public/assets`, but the active hero wave must remain code-driven. Do not delete assets, components, demo data, or business logic unless Bao explicitly approves that deletion.

## Current verified state

- `npm run build` passes.
- Production server responds with HTTP 200 on port 3000.
- Desktop viewport tested at 1280 × 720.
- Mobile viewport tested at 390 × 844 with no horizontal overflow.
- Demo test passes:
  - Click `Telegram message`.
  - Result reaches `Same campaign. New identity.`
  - Click `SEND ANONYMOUS REPORT`.
  - Privacy modal reaches `Share signals. Not your identity.`

## Working rules

1. Start by stating 2–3 concise bullets covering user flow, data/state flow, and top risks before writing product code.
2. Inspect the current page and preserve the selected visual language unless Bao explicitly requests a redesign.
3. Make scoped changes only. Never delete existing code or functionality without explicit approval.
4. Keep the demo interactive; do not replace working states with static mockups.
5. After changes, run a production build and visually test desktop plus 390px mobile.
6. Test the critical interaction path, console errors, reduced motion, drag/drop/paste behavior, and horizontal overflow.
7. Refresh the matching local server and leave the final version available at a concrete URL.
8. Update `design-qa.md` when a visual change is accepted.
9. In the handoff response, explain: user action → client state change → result/report logic → rendered outcome → top failure cases.

## First action in the new session

Open the project, read `AGENTS.md`, inspect `src/App.jsx`, `src/SignalWave.jsx`, and `src/styles.css`, then load `http://127.0.0.1:3000` before proposing or implementing the next request. Treat the existing implementation as the source of truth.

---
