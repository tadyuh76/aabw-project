# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Prototype direction

- Brand the experience as `CheckVar 2.0`: near-black surfaces, white type, and `#DB676D` as the single signature accent.
- Keep all user-facing copy in English. Frame the evolution from fake-news and scam-call checking toward protection for bank customers and bank teams.
- Use the supplied event-screen photo as art direction for perspective grids, terminal-like microcopy, and cinematic motion; do not reproduce the photo literally.
- Avoid wordy screens, icon-heavy navigation, dashboard grids, generic chat bubbles, and decorative cyber-security clichés.
- The demo must remain interactive with realistic scam-campaign evidence and a complete `idle -> scanning -> result -> anonymized report` path.
- On the landing screen, the evidence action must dominate the hierarchy: use a large central drop/paste/type surface instead of letting the headline overpower the CTA.
- The selected landing direction is soft premium fintech: centered hero, rounded evidence capsule, and a smooth horizontal red signal wave. Do not return to brutalist boxes, terminal styling, or perspective grids.
- Center `CHECKVAR 2.0` horizontally in the top navigation; treat it as the top brand anchor.
- The header bar is removed in the selected implementation. `CHECKVAR 2.0` is the main centered hero title and `PROTECT EVERY TRANSFER.` is its subtitle.
- Keep the persistent Moon/Sun light-dark theme toggle visible on both customer and bank flows; light mode is the default, and switching themes must not reset the current scan, result, filters, or campaign context.
- Render the hero wave with React Three Fiber code, not a raster image. Keep it pointer-inert, GPU-friendly, and reduced-motion safe.
- Keep bank-operations text readable at normal viewing distance: essential labels and metadata should not fall below 10px, while evidence values and explanatory copy should generally use 12–14px.
- Structure `/bank` as an operations overview first: bank/scam-tactic filters, plain-language overall situation, prioritized scam campaigns, and a separate next-actions queue. Move technical relationship graphs into a specific-campaign investigation view instead of using them as the landing hierarchy.
- For `/bank`, use readable chart-first analytics inspired by the supplied Brand Protection dashboard, keep a prominent `WHAT TO DO NEXT` action card near the top, and place the large scam-network constellation at the end with 2D as the investigation default and 3D as an optional exploration mode.
