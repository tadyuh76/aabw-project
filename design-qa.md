# CheckVar 2.0 Design QA

- Source visual truth: `/var/folders/yw/cw8hv8gs6pgghzc7l2m18x8w0000gn/T/codex-clipboard-62e7e7c5-b634-41df-9c93-4555125dbab1.png`
- Implementation URL: `http://127.0.0.1:3000`
- Primary implementation screenshot: `qa-checkvar-desktop.png`
- Supporting screenshots: `qa-checkvar-mobile.png`, `qa-checkvar-result.png`, `qa-checkvar-privacy.png`
- Full-view comparison: `qa-checkvar-comparison.png`
- Desktop viewport: 1280 x 720
- Mobile viewport: 390 x 844
- States checked: idle, click-to-upload surface, paste-anywhere input, scanning transition, matched campaign result, official-channel action, privacy preview, anonymized-report success, mobile idle

## Full-view comparison evidence

`qa-checkvar-comparison.png` places the supplied event-screen reference and the final landing screen in one comparison image. The implementation intentionally treats the photograph as art direction rather than a literal UI mock: it preserves the near-black field, sparse perspective tunnel, terminal microtype, muted red signal points, and large directional type while removing the hall-specific content.

The final composition makes the central `THẢ VÀO ĐÂY.` evidence surface the dominant customer action, followed by one text-input rail and three small demo selectors. There is no dashboard grid or generic chatbot chrome.

## Focused-region comparison evidence

- `qa-result-final.png`: settled result state; evidence rows are visible after the entrance motion and the safety action sits beside the verdict.
- `qa-report-final.png`: privacy preview; redacted fields, primary consent action, explicit cancel action, and 44px close control are visible.
- `qa-mobile-final.png`: 390 x 844 idle state; no horizontal overflow (`pageWidth: 390`, `viewportWidth: 390`), shortened placeholder, stacked primary CTA, and horizontally scrollable demo labels.
- `qa-big-cta-mobile.png`: revised 390 x 844 landing state; the central drop surface, input rail, scan action, and demo selectors all fit without horizontal or vertical overflow (`pageWidth: 390`, `pageHeight: 844`).

## Required fidelity surfaces

- Fonts and typography: system grotesk plus system monospace create the reference's editorial/terminal contrast. Display type is intentionally oversized with tight tracking; Vietnamese diacritics remain readable in settled desktop and mobile states.
- Spacing and layout rhythm: flat full-bleed page, thin dividers, no rounded card stack, and large controlled negative space match the source mood. The short-height desktop media query keeps the input and result actions visible on laptop screens.
- Colors and visual tokens: `#050505` base, warm white foreground, and exact `#DB676D` as the single signature accent. The background raster is hue-shifted toward the new brand color without changing its texture or hierarchy.
- Image quality and asset fidelity: `public/assets/scamdna-tunnel.png` is a dedicated 1536 x 1024 raster asset derived from the reference's perspective-grid art direction; no CSS/SVG substitute is used for the hero texture.
- Copy and content: copy remains action-first and short. The result never claims that an unmatched item is safe, and the high-confidence label avoids false numeric precision.
- Icons: Phosphor icons are used sparingly for attachment, direction, official phone, warning, and privacy confirmation; no custom inline SVG icons are present.
- Motion and accessibility: scan progression, staggered evidence, modal transitions, clear focus styles, semantic controls, labels, and `prefers-reduced-motion` support are present.

## Comparison history

### Pass 1 — blocked

- P1: mobile placeholder and demo row were crowded, and development chrome overlapped the first demo. Fix: shortened the placeholder, made demos horizontally scrollable, added mobile height tuning, and validated the production build without development chrome.
- P1: safety CTA did not prove it opened an official channel. Fix: renamed it to `DỪNG — MỞ KÊNH CHÍNH THỨC` and added a verified-channel disclosure before showing the official demo number.
- P2: immediate action was visually detached from the STOP verdict. Fix: removed the expanding result row and moved the evidence/action block upward with short-height layout rules.
- P2: small evidence metadata was too faint. Fix: increased its size and contrast.
- P2: exact match percentages implied unjustified precision. Fix: replaced them with `MỨC KHỚP: RẤT CAO/CAO`.
- P2: report cancellation depended on the close icon. Fix: added a visible `Không gửi` action and enlarged/labeled the close control.

### Pass 2 — passed

- Post-fix desktop evidence: `qa-idle-final.png`, `qa-result-final.png`, `qa-report-final.png`.
- Post-fix mobile evidence: `qa-mobile-final.png`; no horizontal overflow.
- Production smoke test: demo selection reached the campaign result; official channel and anonymized report flows opened; report success rendered.
- Browser console: no warnings or errors.
- Build: `next build` completed successfully.
- No actionable P0, P1, or P2 findings remain.

### Pass 3 — CTA hierarchy update passed

- User feedback: the landing screen needed a much larger central CTA that explicitly prompts users to type, paste, click, or drop evidence.
- Fix: reduced the headline's visual dominance and introduced one large central drop surface with click-to-upload, drag/drop feedback, paste-anywhere support, a text input, and the existing scan action.
- Post-fix desktop evidence: `qa-big-cta.png` and `qa-big-cta-comparison.png`.
- Post-fix mobile evidence: `qa-big-cta-mobile.png`; page width and height match the 390 x 844 viewport with no overflow.
- Interaction evidence: pasting `vieclam-linhhoat.site` outside the input triggered the correct Remote Task Farm result.
- Browser console: no warnings or errors.
- Build: `next build` completed successfully.
- No actionable P0, P1, or P2 findings remain.

### Pass 4 — CheckVar 2.0 rebrand passed

- User feedback: rename the product to `CheckVar 2.0`, switch the accent to `#DB676D`, acknowledge the product's fake-news and scam-call history, position the new banking direction, and make the full experience English.
- Fix: updated brand, metadata, HTML language, accent tokens, background color treatment, hero narrative, demo data, scan steps, result actions, privacy flow, accessibility labels, and verified-channel copy.
- Brand line: `From checking claims and scam calls to protecting every transfer.`
- Post-fix evidence: `qa-checkvar-desktop.png`, `qa-checkvar-result.png`, `qa-checkvar-privacy.png`, and `qa-checkvar-mobile.png`.
- Mobile evidence: 390 x 844, `pageWidth: 390`, `pageHeight: 844`, and no overflow.
- Browser document evidence: `lang=en` and title `CheckVar 2.0 — Check before you transfer`.
- Browser console: no warnings or errors.
- Build: `next build` completed successfully.
- No actionable P0, P1, or P2 findings remain.

## Follow-up polish

- P3: test additional real-device font fallbacks if this becomes a deployed product rather than a hackathon demo.
- P3: replace the demo bank number with a bank-configured verified directory when the real integration exists.

### Pass 5 — code-driven signal wave and hero hierarchy passed

- Selected layout reference: `/var/folders/yw/cw8hv8gs6pgghzc7l2m18x8w0000gn/T/codex-clipboard-6b009fe1-f1af-4c18-b781-5f6200e41a08.png`.
- User feedback: remove the header bar, make `CHECKVAR 2.0` the primary hero title, move `PROTECT EVERY TRANSFER.` to the subtitle, and replace the raster hero wave with a smooth code-driven animation.
- Fix: the landing now renders 22 additive-blended Three.js signal lines through React Three Fiber. Geometry buffers are allocated once and updated in the render loop; the canvas is pointer-inert and respects reduced-motion preference.
- Desktop evidence: `qa-coded-wave-final.png` at 1280 x 720. The centered hero, capsule CTA, and animated red wave match the selected premium-fintech composition.
- Mobile evidence: `qa-coded-wave-mobile.png` at 390 x 844. Playwright verified `scrollWidth === innerWidth`; the title, two-row CTA, helper copy, and demo selectors fit without horizontal overflow.
- Interaction evidence: Playwright verified `Telegram message` reaches `Same campaign. New identity.` and the report action opens `Share signals. Not your identity.`.
- Build: `next build` completed successfully; production server responds on port 3000.
- No actionable P0, P1, or P2 findings remain.

### Pass 6 — reference-matched expanded signal field passed

- Source visual truth: `/var/folders/yw/cw8hv8gs6pgghzc7l2m18x8w0000gn/T/codex-clipboard-9ca270f7-cebe-47f6-87a9-ce1d7f903cb9.png`.
- User feedback: the prior code-driven wave was too small and visually unrelated to the selected reference; the requested wave should converge behind the evidence capsule and expand into a larger contour field on both sides.
- Pass 1 evidence: `qa-wave-reference-pass-1b.png`; structure matched the converge/fan pattern, but the field was materially smaller and less energetic than the source (P1).
- Pass 1 fix: increased the contour spread, shared-current amplitude, canvas stage height, and mobile width; added a dedicated multi-line glow band around the main signal spine.
- Post-fix desktop evidence: `qa-wave-reference-final.png` at 1280 x 720.
- Full-view comparison evidence: `qa-wave-comparison-pass-2.png`; the implementation now reproduces the source's large edge fan, compressed center path, single highlighted spine, dark field, and capsule overlap. The surrounding hero typography intentionally remains the existing selected CheckVar implementation.
- Focused-region comparison: the wave/CTA region is large and readable in the full-view comparison, so a separate crop was not required.
- Mobile evidence: `qa-wave-reference-mobile-final.png` at 390 x 844; `scrollWidth === innerWidth`, canvas rendered, and the expanded wave remained behind the stacked CTA.
- Fonts and typography: unchanged by this scoped wave edit; existing CheckVar hierarchy and English copy remain intact.
- Spacing and layout rhythm: wave stage expanded without moving or obscuring the interactive capsule.
- Colors and tokens: all contours use the existing `#DB676D` accent; the main spine uses a warm highlight plus additive accent-band glow.
- Image/asset fidelity: the supplied screenshot is the visual target only; the active wave remains code-driven React Three Fiber geometry as required, with no raster replacement.
- Copy/content: unchanged.
- Interaction evidence: `Telegram message` reached `Same campaign. New identity.`; `SEND ANONYMOUS REPORT` opened `Share signals. Not your identity.`.
- Browser console: no errors.
- Build: `next build` completed successfully; production server is listening on port 3000.
- Reduced motion: geometry initializes to a complete static frame and the canvas uses demand rendering.
- No actionable P0, P1, or P2 findings remain. Residual glow intensity is P3 visual tuning.

final result: passed
