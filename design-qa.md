# CheckVar 2.0 Design QA

## Bank typography and scam-tactic taxonomy — 11 Jul 2026

- Replaced the bank-product filter and campaign scope with scam tactics: impersonation, phishing, QR relay, vishing, advance fee, account takeover, and malicious APK.
- The scam-tactic filter now drives overview metrics, chart datasets, campaign scope, case detail chips, action priority, and the network scope through the same React state path.
- Increased filter, chart-axis, chart-legend, campaign-table, activity, next-action, and case-detail typography by 1–2px with stronger muted-text contrast.
- Desktop evidence: `/Users/bao/GitHub/aabw-project/qa-bank-tactic-readability-desktop.png` at 1440 x 1100.
- Mobile evidence: `/Users/bao/GitHub/aabw-project/qa-bank-tactic-readability-mobile.png` at 390 x 844.
- Verified `PHISHING` returns two campaigns and promotes the biometric-reset escalation as the urgent action.
- Production build passed. Mobile `scrollWidth === innerWidth`. Browser console errors: none.

final result: passed

## Bank chart-first analytics and 2D/3D constellation — 11 Jul 2026

**Source visual truth**

- `/var/folders/yw/cw8hv8gs6pgghzc7l2m18x8w0000gn/T/codex-clipboard-c4aa2d21-96df-4a0c-af9e-1340953f18d8.png`
- `/Users/bao/Downloads/brand-protection-2d-graph-files/`
- The reference controls information hierarchy and chart density; the existing CheckVar near-black palette, typography, and `#DB676D` accent remain intentional product constraints.

**Implementation evidence**

- Desktop overview: `/Users/bao/GitHub/aabw-project/qa-bank-chart-dashboard-desktop.png` at 1440 x 1100.
- Mobile overview: `/Users/bao/GitHub/aabw-project/qa-bank-chart-dashboard-mobile.png` at 390 x 844.
- 2D network: `/Users/bao/GitHub/aabw-project/qa-bank-constellation-2d.png`.
- 3D network: `/Users/bao/GitHub/aabw-project/qa-bank-constellation-3d.png`.
- Full-view comparison: `/Users/bao/GitHub/aabw-project/qa-bank-reference-comparison.png`.
- Focused graph comparison: `/Users/bao/GitHub/aabw-project/qa-bank-graph-comparison.png`.

**Findings and comparison history**

- [Resolved P2] The first exposure-by-bank capture clipped `TECHCOMBANK` on the Y axis. Increased the category-axis allocation and re-captured the settled chart; every bank label is now readable.
- [Resolved P2] The first 42-node 2D constellation rendered too many labels in the centre. Added an expanded graph layout with stronger repulsion, longer links, larger collision spacing, and campaign-first label visibility. The final focused comparison preserves the reference's dense constellation while keeping campaign names legible.
- Typography: essential chart labels and card copy remain at readable 10–14px sizes; major decisions and actions use 18–29px headings. No critical content relies on sub-10px text.
- Layout rhythm: the page follows the reference's sequence of global filters, summary analytics, multiple chart cards, activity cards, case review, and a large final network graph. The prominent `WHAT TO DO NEXT` card is intentionally added beside the overall situation.
- Colors/tokens: the reference's light palette is not copied; CheckVar's near-black surfaces, white text, muted rose series, and single `#DB676D` signature accent are consistently retained.
- Image/asset fidelity: the reference contains no required photographic assets. Charts use Recharts, icons use the existing Phosphor library, 2D uses the code-native canvas graph, and 3D uses React Three Fiber/WebGL.
- Copy/content: labels are rewritten for bank scam operations instead of brand-protection domains, while preserving the reference's plain-language dashboard hierarchy.

**Primary interactions tested**

- Bank, product, and time filters update the situation metrics and chart scope.
- Clicking the `QR PAYMENT` chart legend sets the product filter and returns two matching campaigns.
- `WHAT TO DO NEXT` opens the correct action-review state and explicitly reports demo-only delivery.
- 2D and 3D graph toggles both render the same 42-node, 41-link scoped network. Browser console errors: none.
- Mobile verification at 390 x 844: `scrollWidth === innerWidth`; filters, metrics, charts, cards, and constellation stack without horizontal overflow.

**Follow-up polish**

- P3: the 3D mode intentionally omits persistent labels to avoid occlusion; selected-node context remains available in the fixed inspector card.

final result: passed

## Bank operations overview — 11 Jul 2026

- Reframed `/bank` from a relationship-graph-first report into an operations overview with affected-bank and bank-product filters.
- Added six realistic cross-bank scam campaigns covering transfer, QR payment, mobile banking, card, and digital-onboarding products.
- Added a plain-language overall situation, prioritized campaign list, and a separate action queue with owner, due time, reason, and concrete review CTA.
- Each campaign opens a specific-scam detail with affected users, recent changes, evidence, indicators, and a recommended next action.
- Preserved the existing VNeID relationship graph, node intelligence, confirm/reject decisions, evidence modal, indicator creation, and export workflows under an optional deep-investigation section.
- Verified `VCB + QR PAYMENT` filtering returns one matching campaign with matching metrics and action queue.
- Verified a different campaign opens the correct detail, action feedback is explicitly demo-only, and VNeID relationship confirmation still works.
- Production build passed. Desktop checked at 1280 x 720. Mobile checked at 390 x 844 with `scrollWidth === innerWidth`. Browser console errors: none.

final result: passed

## Screenshot attachment composer — 11 Jul 2026

- Source interaction reference: `/var/folders/yw/cw8hv8gs6pgghzc7l2m18x8w0000gn/T/codex-clipboard-86e21508-fd5c-42c3-b9e9-45e521051f05.png`.
- Desktop implementation: `/Users/bao/GitHub/aabw-project/.codex-attachment-preview-final.png`.
- Mobile implementation: `/Users/bao/GitHub/aabw-project/.codex-attachment-preview-mobile.png` at 390 x 844.
- Combined reference/implementation comparison: `/Users/bao/GitHub/aabw-project/.codex-attachment-comparison.png`.

### Findings and fixes

- [Resolved P0] Pasting an image while the evidence input had focus was ignored. Clipboard image files now take priority over the focused-text guard.
- [Resolved P1] Selecting or dropping a file previously started scanning immediately, so users could not verify or remove the evidence. Attachments now remain in a reviewable tray until `CHECK NOW` is submitted.
- Typography and copy follow the existing CheckVar English UI while the attachment filename remains readable and truncates safely.
- Spacing and layout reproduce the reference composer anatomy: image preview above, remove action on the preview, then attachment/input/submit controls below. The 390px layout has `scrollWidth === innerWidth`.
- Colors and tokens preserve CheckVar's light premium-fintech surface and `#DB676D` accent rather than copying Codex's dark application chrome.
- Image quality uses the browser-provided object URL directly with `object-fit: cover`; no placeholder or generated image replaces the user's evidence.
- The existing Phosphor icon system provides the plus, close, and submit icons.
- Browser console errors: none. Production build: passed.

### Interactions verified

- Paste an image with the text input focused -> thumbnail appears without starting the scan.
- Remove the thumbnail -> attachment tray disappears.
- Paste again and submit -> scanner completes and renders the matching campaign result.
- Desktop and 390px mobile previews retain the input and primary action without horizontal overflow.

No actionable P0, P1, or P2 findings remain. The full-page colors differ intentionally because the source is an interaction reference, while the attachment composer anatomy is the selected fidelity surface.

final result: passed

## Current selected implementation

- Framework: Next.js App Router.
- Desktop viewport: 1280 x 720.
- Mobile viewport: 390 x 844 with no horizontal overflow.
- States checked: idle, scanning, matched campaign result, official-channel action, privacy preview, and anonymized-report success.
- Visual direction: premium minimal fintech, near-black surfaces, white text, and `#DB676D` as the single accent.
- Hero: a pointer-inert React Three Fiber signal wave with a static reduced-motion frame. No raster hero asset is used.

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

## Bank campaign report — 11 Jul 2026

- Route: `/bank`.
- Product brief: connect social-listening mentions and privacy-redacted customer reports into campaign-level evidence, then let a fraud analyst confirm relationships, add rotated indicators, and export an evidence package to SOC/takedown teams.
- Desktop evidence: `qa-bank-report-compact.png` at 1440 x 900.
- Mobile evidence: `qa-bank-report-mobile.png` at 390 x 844.
- Graph implementation: `d3-force` for physics and native HTML canvas for nodes, edges, labels, cluster regions, pan, zoom, and selection.
- Mock intelligence: one campaign, one operational persona, 41 social mentions, 12 customer reports, rotated phone/account/domain indicators, confirmed and suggested relationships, and evidence paths.
- Analyst critical path verified:
  1. `CONFIRM RELATIONSHIP` changes the edge decision from suggested to confirmed and campaign confidence from 87% to 94%.
  2. Compact `ADD NEW INDICATOR` opens the indicator form without retaining the removed rotation table.
  3. API export renders a delivered state with a stable mock delivery ID.
- Export surfaces: API, webhook, and CSV.
- Customer route remains available and links to `/bank` through `BANK OPERATIONS`.
- Accepted scope update: the large `INDICATOR ROTATION` and `CAMPAIGN TIMELINE` panels were removed; `EVIDENCE EXPORT` now occupies the remaining lower row.
- Responsive verification: `scrollWidth === innerWidth` at both 1440px and 390px.
- Browser console: no errors.
- Production build: passed with static `/` and `/bank` routes.
- Accessibility: semantic analyst controls, visible focus states, labeled indicator form, live export status, reduced-motion-aware force settling, and a textual evidence panel alongside the canvas graph.
- Remaining P3: dense canvas labels may overlap while the force simulation is settling; pan/zoom and the selected-node chip preserve usability.

## Dynamic node intelligence inspector — 11 Jul 2026

- Desktop evidence: `qa-bank-node-inspector.png` at 1440 x 900.
- Full-evidence evidence: `qa-bank-full-evidence.png` at 1440 x 900.
- Mobile evidence: `qa-bank-full-evidence-mobile.png` at 390 x 844.
- All 14 graph nodes have a dedicated detail record; no node falls back to stale content from the previous selection.
- Canvas selection updates the right inspector without restarting the D3 simulation or resetting zoom/pan.
- Inspector surfaces: node-specific status, confidence, facts, connected relationships, related posts, relationship decision when applicable, full evidence, CSV export, and new-indicator action.
- Relationship decisions are stored per edge. Confirming report `12,843` updates only `l5`; other suggested edges retain their state.
- Full evidence popup contains node-specific evidence records and related posts, closes by X, Escape, or backdrop, and restores focus to its opener.
- CSV report generation includes campaign/node metadata, adjacent relationships, evidence, related posts, analyst decision state, and redaction status. Values are CSV-escaped and formula-prefixed values are neutralized.
- Suggested relationships export as a draft; confirmed relationships export as a report.
- Responsive verification: inspector and modal have no horizontal overflow at 390px; the modal is 370px wide inside a 390px viewport.
- Browser console: no errors.
- Production build: passed.

final result: passed

## Light mode default and theme toggle — 11 Jul 2026

- Product requirement: add light and dark modes, expose an interactive toggle, and make light mode the default.
- Light landing: `/Users/bao/GitHub/aabw-project/.codex-light-mode-landing.png`.
- Light scam result: `/Users/bao/GitHub/aabw-project/.codex-light-mode-scam-result.png`.
- Light safe-result viewport: `/Users/bao/GitHub/aabw-project/.codex-light-mode-safe-result-viewport.png`.
- Light/dark comparison: `/Users/bao/GitHub/aabw-project/.codex-theme-comparison.png`.
- Desktop viewport: 1280 x 720. Responsive check: 390 x 844 with `scrollWidth === innerWidth`.

### Findings and fixes

- Light mode now initializes synchronously as `theme-light`, preventing a dark-first flash and satisfying the default-mode requirement.
- The persistent theme toggle uses Phosphor Moon/Sun icons, accessible `Switch to dark mode` / `Switch to light mode` labels, and an `aria-pressed` state.
- Switching themes preserves the current checker phase and verdict; a 93% safe result remained mounted while toggling to dark mode.
- Light tokens cover landing, scanner, scanning surfaces, impact metrics, evidence cards, victim/source panels, safe zero states, and report-modal styling.
- Typography and layout hierarchy are unchanged. Light mode uses `#151313` foreground on `#F4F1ED` with white card surfaces and `#DB676D` as the signature accent.
- Safe confidence uses a dark ring in light mode and a light ring in dark mode, preserving semantic contrast without adding a second accent color.
- The mobile toggle and `NEW CHECK` control occupy separate non-overlapping regions; no horizontal document overflow was detected.
- Image and icon fidelity: no new raster assets were required; the existing React Three Fiber wave and Phosphor icon system are preserved.
- Browser console: no application errors.

### Interactions verified

- First load renders light mode.
- Toggle changes to dark mode and updates its label to `LIGHT`.
- Toggle changes back to light mode.
- Theme changes do not reset a scam or safe result.

Focused comparison covered the landing and result surfaces because palette contrast, card separation, wave visibility, and persistent toggle placement were the acceptance surfaces.

final result: passed

## No-known-risk verdict state — 11 Jul 2026

- Product requirement: the checker must support both scam and no-known-risk outcomes with confidence shown in both states.
- Desktop implementation: `/Users/bao/GitHub/aabw-project/.codex-safe-result-desktop.png` at 1280 x 720.
- Mobile viewport implementation: `/Users/bao/GitHub/aabw-project/.codex-safe-result-mobile-viewport.png` at 390 x 844.
- State comparison: `/Users/bao/GitHub/aabw-project/.codex-verdict-states-comparison.png`.
- Demo state: known Shinhan recipient `110-482-902184`.

### Findings and fixes

- [Resolved P1] Every demo previously resolved to a scam campaign, making the checker appear predetermined rather than evidence-driven.
- Added a fifth `Known recipient` demo with the cautious verdict `Appears safe`, 93% verdict confidence, and the explicit statement `No cases recorded for this account.`
- Added four positive checks: account history, zero linked cases, recipient-name match, and message-intent analysis.
- Added symmetric zero states for recorded cases, linked victims, reported loss, source matches, case history, and monitored social sources.
- Safe-state language never guarantees that a transfer is safe; the secondary CTA routes uncertain users to Shinhan's official channel.
- Typography, spacing, near-black palette, existing Phosphor icon system, and compact result anatomy remain consistent with the scam result.
- The safe state uses white as its semantic emphasis while preserving `#DB676D` as the product signature accent.
- Desktop and mobile have no horizontal document overflow. The two persistent safe-state CTAs remain inside the 390px viewport.
- Browser console: no application errors.

### Interactions verified

- `Known recipient` reaches the 93% `Appears safe` result.
- `CONTACT SHINHAN IF UNSURE` reveals the verified official phone number.
- `CHECK ANOTHER TRANSFER` returns to the landing checker.
- Scam and mixed-evidence demos remain available and unchanged.

Focused comparison covered the full scam/safe state pair because parity of confidence, hierarchy, and evidence framing was the acceptance surface.

final result: passed

## Bank operational actions — 11 Jul 2026

- Desktop evidence: `/Users/bao/GitHub/aabw-project/qa-bank-operational-actions-desktop-final.png` at 1280 x 720.
- Mobile evidence: `/Users/bao/GitHub/aabw-project/qa-bank-operational-actions-mobile.png` at 390 x 844.
- Replaced delivery-format-first labels with three outcome-led workflows: SOC remediation, fraud-analyst escalation, and high-confidence scam-account ban review.
- The action package derives 2 eligible accounts, 4 canonical evidence records, and 2 supporting sources from mock data using the visible policy `confirmed + confidence ≥95%`.
- The CSV includes internal account references, masked display values, evidence IDs, campaign ID, decision state, decision timestamp, and recommended action. Customer identity remains excluded.
- SOC and analyst handoffs are explicitly labeled demo mode; the prototype does not claim an external API/webhook delivery occurred.
- All three actions were exercised and returned their matching status. Browser console errors: none.
- Mobile verification: `scrollWidth === innerWidth` at 390px; all action cards remain fully visible and stacked.

final result: passed

## Multi-input evidence analysis — 11 Jul 2026

- Source issue: `/var/folders/yw/cw8hv8gs6pgghzc7l2m18x8w0000gn/T/codex-clipboard-9c80ccd0-adcc-42fc-adec-4312cadfc159.png` showed a flat three-row evidence list without input provenance or combined-evidence behavior.
- Desktop implementation: `/Users/bao/GitHub/aabw-project/.codex-multi-input-evidence-desktop.png` at 1280 x 720.
- Mobile implementation: `/Users/bao/GitHub/aabw-project/.codex-multi-input-evidence-mobile.png` at 390 x 844.
- Focused before/after comparison: `/Users/bao/GitHub/aabw-project/.codex-evidence-comparison.png`.
- State: mixed image + QR + text evidence bundle.

### Findings and fixes

- [Resolved P1] The previous panel did not reveal which input produced each signal, so users could not understand how a screenshot, QR, URL, or pasted text affected the verdict.
- Added provenance labels, per-signal confidence, extraction notes, and working `ALL / IMAGE / QR / TEXT / URL` filters.
- Added four realistic demo cases: screenshot/OCR, QR plus text, URL plus text, and a three-input mixed bundle.
- Multi-file image selection now routes two or more uploaded images into the mixed-evidence path; a filename containing `qr` routes to QR analysis.
- Typography: signal values remain 13–15px with secondary extraction notes at 10–11px; compact mono labels remain subordinate.
- Layout: desktop promotes evidence to the primary two-row column while victim history and social sources remain visible alongside it. Mobile stacks every signal with `scrollWidth === innerWidth`.
- Colors, icon system, safety CTAs, privacy flow, and anonymized victim presentation remain consistent.
- Image assets: no new raster assets were required for this structured evidence UI.
- Copy: the interface continues to mark all intelligence as demo data; the OCR, QR decode, entity extraction, and cross-signal confidence values are mock behavior, not a live backend claim.

### Cases verified

- Screenshot/OCR: 3 `IMAGE` signals + 1 `TEXT` intent signal.
- QR plus message: 3 `QR` signals + 1 `TEXT` signal.
- URL plus message: 3 `URL` signals + 1 `TEXT` signal.
- Mixed bundle: 2 `IMAGE` + 2 `QR` + 1 `TEXT`; selecting the QR filter renders exactly the two QR rows.
- Browser console: no application errors.

Focused comparison covered the evidence panel because source provenance, confidence, and combined-signal behavior were the acceptance surfaces for this iteration.

final result: passed

final result: passed

## Result typography readability pass — 11 Jul 2026

- Source issue: user feedback that the compact result typography was too small to read comfortably.
- Before/after comparison: `/Users/bao/GitHub/aabw-project/.codex-readability-comparison.png`.
- Desktop implementation: `/Users/bao/GitHub/aabw-project/.codex-result-readable-desktop.png` at the actual 1280 x 720 browser viewport.
- Mobile implementation: `/Users/bao/GitHub/aabw-project/.codex-result-readable-mobile.png` at 390 x 844.
- State: settled VNeID campaign result.

### Findings and fixes

- [Resolved P1] Evidence, victim, source, and metadata text used 7–10px sizes that were visually polished but not comfortably readable.
- Evidence values now render at 14px; victim and source summaries at 13px; panel headings at 11px; secondary metadata at 9–10px.
- Row heights increased from 67px to 78px, preserving line spacing and tap/readability without restoring the oversized hero.
- Mono letter spacing was reduced on dense labels so larger text does not become wider than its card.
- Desktop keeps all three proof panels in the first viewport. Mobile remains at `scrollWidth === innerWidth` with no clipped primary actions.
- Color, icon, image, copy, and interaction surfaces remain unchanged from the prior passed design.
- Browser console check: no application errors.

Focused comparison covered the proof panels because evidence readability was the blocking acceptance surface for this iteration.

final result: passed

## Compact evidence-first customer result — 11 Jul 2026

- Source visual truth: `/var/folders/yw/cw8hv8gs6pgghzc7l2m18x8w0000gn/T/codex-clipboard-98c2486e-0faa-46f9-b9ad-82ea9cf9cb2b.png`, with explicit user feedback that the verdict hero consumed too much space.
- Browser-rendered implementation: `/Users/bao/GitHub/aabw-project/.codex-result-compact-1440.png`.
- Before/after comparison: `/Users/bao/GitHub/aabw-project/.codex-compact-comparison.png`.
- Mobile implementation: `/Users/bao/GitHub/aabw-project/.codex-result-compact-mobile.png`.
- Viewports: 1440 x 900 desktop and 390 x 844 mobile.
- State: settled VNeID campaign result after `idle -> scanning -> result`.

### Findings

- No actionable P0, P1, or P2 findings remain.
- Typography: verdict scale is reduced from the prior full-viewport hero while preserving the selected grotesk/mono hierarchy; dense evidence labels remain legible.
- Spacing and layout: desktop shows verdict, confidence, CTAs, five impact metrics, evidence, three victim reports, and three social sources in one viewport. Mobile stacks the same hierarchy with `scrollWidth === innerWidth`.
- Colors and tokens: near-black, white, muted gray, and `#DB676D` remain consistent with the landing screen.
- Image and icon fidelity: no missing image assets; standard actions continue to use the existing Phosphor icon system.
- Copy and content: victim records are explicitly anonymized, one prevented-loss case is included, and all intelligence is labeled as demo data.

### Primary interactions tested

- Demo evidence reaches the compact result.
- `CONTACT SHINHAN NOW` reveals the verified official number.
- `REPORT ANONYMOUSLY` opens the privacy preview dialog.
- No browser console errors were recorded. The existing Three.js landing-wave deprecation warning remains non-blocking.

### Comparison history

1. Previous result: verdict headline and confidence card consumed most of the 900px viewport, pushing proof below the fold.
2. Fix: replaced the large hero/card pair with a compact three-part result strip, added a five-metric impact row, and promoted evidence, anonymized victim history, and related sources into a three-column primary region.
3. Post-fix evidence: `/Users/bao/GitHub/aabw-project/.codex-compact-comparison.png` visibly shows the increased information density and evidence-first hierarchy.

Focused comparison used the three proof panels because their content density, truncation, and alignment are the core acceptance surface for this iteration.

final result: passed

## Customer result hero refresh — 11 Jul 2026

- Source visual truth: `/var/folders/yw/cw8hv8gs6pgghzc7l2m18x8w0000gn/T/codex-clipboard-e46b2988-ac84-421e-aa2b-35558b15e145.png` for the selected premium CheckVar design language, plus the user brief for the new result hierarchy.
- Browser-rendered implementation: `/Users/bao/GitHub/aabw-project/.codex-result-1440.png`.
- Side-by-side comparison evidence: `/Users/bao/GitHub/aabw-project/.codex-design-comparison.png`.
- Mobile evidence: `/Users/bao/GitHub/aabw-project/.codex-result-mobile.png`.
- Viewports: 1440 x 900 desktop and 390 x 844 mobile.
- State: VNeID campaign result after the full `idle -> scanning -> result` path.

### Findings

- No actionable P0, P1, or P2 findings remain.
- Typography keeps the source's large white grotesk headline, compact mono metadata, and strong red verdict accents without allowing the result headline to overpower the safety action.
- Spacing and layout use a clear two-column desktop hero and a single-column mobile stack. Browser verification reports `scrollWidth === innerWidth` at 390px.
- Colors stay within the near-black, white, muted gray, and `#DB676D` token system.
- The result has no missing raster or custom image assets; icons use the existing Phosphor library. The confidence treatment is code-native UI, not replacement artwork.
- Copy now exposes the requested verdict, confidence, evidence, repeated-report count, and related social sources. Mock-only intelligence is explicitly labeled.

### Interaction checks

- `Telegram message` completes the scan and renders the 96% campaign result.
- `CONTACT SHINHAN NOW` opens the verified official-channel toast.
- `SEND ANONYMOUS REPORT` opens the privacy/redaction preview.
- `NEW CHECK` and the CheckVar brand return to the input state.
- Browser console has no app errors. One existing Three.js deprecation warning remains in the landing wave dependency.

### Comparison history

1. Initial mobile capture: the verdict and action labels were too large for a calm 390px composition.
2. Fix: reduced mobile verdict sizing and tightened CTA padding/gaps.
3. Post-fix evidence: `/Users/bao/GitHub/aabw-project/.codex-result-mobile.png` shows the complete hero, both CTAs, confidence card, evidence, and source panels without horizontal overflow.

Focused-region comparison was not required beyond the mobile pass because the desktop source and implementation use different screen content by design; the combined full view clearly verifies typography, palette, density, radii, and CTA treatment.

final result: passed

## Customer result CTA removal — 11 Jul 2026

- Removed `CONTACT SHINHAN NOW` and `REPORT ANONYMOUSLY` from the scam-detected result only.
- Preserved the safe-result actions and the existing bank/report state logic outside this render surface.
- Rebalanced the scam verdict strip from three columns to two columns so removal does not leave an empty action rail.
- Desktop evidence: `/Users/bao/GitHub/aabw-project/qa-result-actions-removed-desktop.png` at 1280 x 720.
- Mobile evidence: `/Users/bao/GitHub/aabw-project/qa-result-actions-removed-mobile.png` at 390 x 844.
- Mobile verification: `scrollWidth === innerWidth`; browser console errors: none.

final result: passed

## Bank typography readability pass — 11 Jul 2026

- Before: `/Users/bao/GitHub/aabw-project/qa-bank-readability-before.png` showed essential inspector and graph metadata at 7–10px.
- Desktop after: `/Users/bao/GitHub/aabw-project/qa-bank-readability-after.png` and `/Users/bao/GitHub/aabw-project/qa-bank-readability-actions.png` at 1280 x 720.
- Mobile after: `/Users/bao/GitHub/aabw-project/qa-bank-readability-mobile.png` and `/Users/bao/GitHub/aabw-project/qa-bank-readability-mobile-inspector.png` at 390 x 844.
- Mobile evidence modal: `/Users/bao/GitHub/aabw-project/qa-bank-readability-mobile-modal.png`.
- Essential labels now use 10–11px, evidence values 13–14px, and explanatory copy 12–14px. Canvas node labels were increased by 1–2px without changing graph behavior.
- Verified the relationship inspector, operational actions, full evidence modal, and 390px layout with `scrollWidth === innerWidth`.
- Browser console errors: none. Production build: passed.

final result: passed
