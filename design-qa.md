# CheckVar 2.0 Design QA

## Current selected implementation

- Framework: Next.js App Router.
- Desktop viewport: 1280 x 720.
- Mobile viewport: 390 x 844 with no horizontal overflow.
- States checked: idle, scanning, matched campaign result, official-channel action, privacy preview, and anonymized-report success.
- Visual direction: premium minimal fintech, near-black surfaces, white text, and `#DB676D` as the single accent.
- Hero: a pointer-inert React Three Fiber signal wave with a static reduced-motion frame. No raster hero asset is used.

## Retained evidence

- `qa-coded-wave-final.png`: final desktop landing state.
- `qa-coded-wave-mobile.png`: final mobile landing state.
- `qa-result-final.png`: settled campaign result state.
- `qa-report-final.png`: privacy-redacted report preview.

## Verified critical path

1. A customer types, pastes, drops, or selects suspicious evidence.
2. The client advances through the scan state and matches the evidence to demo campaign intelligence.
3. The result explains the related signals and presents an official-channel safety action.
4. The anonymous-report action opens a privacy preview with redacted customer fields and explicit send/cancel controls.

The result never describes an unmatched item as safe. Motion respects `prefers-reduced-motion`, and the evidence action remains usable on desktop and mobile.

## Current verification

- `next build` passes.
- `Telegram message` reaches `Same campaign. New identity.`
- `SEND ANONYMOUS REPORT` opens `Share signals. Not your identity.`
- No actionable P0, P1, or P2 design findings remain.
