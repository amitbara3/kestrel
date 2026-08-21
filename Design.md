# Design — Kestrel

The visual system for the web UI at `/`, and for anything else the project renders. Kestrel is infrastructure, so the design language is instrument-panel: dark, monospaced, dense, precise. Nothing decorative that does not carry information.

---

## 1. Principles

1. **Data over chrome.** No gradients-as-decoration, no drop shadows for depth theatre, no illustration. Every pixel that is not a value, a label, or a boundary is removed.
2. **Terminal lineage.** The audience lives in a terminal. The UI should feel like a well-designed status pane, not a SaaS landing page.
3. **Latency is the product, so show it.** Response time and cache tier are displayed on every result. The thing the system is good at should be visible.
4. **One accent colour.** Amber, and only amber, for the interactive and the important. When everything is highlighted, nothing is.
5. **Legible at a glance.** Strong contrast, clear hierarchy, no text below 12 px.

## 2. Colour

Dark is the default and primary theme. Light is supported for anyone whose OS asks for it.

### Dark (default)

| Token | Hex | Use |
| --- | --- | --- |
| `--bg` | `#0B0D10` | Page background — near-black, slightly blue |
| `--surface` | `#12151A` | Cards, panels |
| `--surface-2` | `#181C22` | Inputs, nested panels, table stripes |
| `--border` | `#242A33` | Hairlines, dividers |
| `--border-strong` | `#333B47` | Focused input, active card edge |
| `--text` | `#E6EAF0` | Primary text |
| `--text-dim` | `#9AA4B2` | Secondary text, labels |
| `--text-faint` | `#5D6673` | Placeholders, disabled, footnotes |
| `--accent` | `#F5A524` | Primary action, links, focus, brand |
| `--accent-hover` | `#FFB84D` | Hover state |
| `--accent-dim` | `#4A3A17` | Accent-tinted fills, badge backgrounds |
| `--success` | `#3FB950` | Cache hit, healthy, 2xx |
| `--warning` | `#D29922` | Degraded, 429 |
| `--danger` | `#F85149` | Error, unhealthy, 5xx |
| `--info` | `#58A6FF` | Neutral informational, cache miss |

### Light

| Token | Hex |
| --- | --- |
| `--bg` | `#FAFAF9` |
| `--surface` | `#FFFFFF` |
| `--surface-2` | `#F4F4F2` |
| `--border` | `#E4E4E1` |
| `--border-strong` | `#C9C9C4` |
| `--text` | `#16181D` |
| `--text-dim` | `#5A6069` |
| `--text-faint` | `#8B929C` |
| `--accent` | `#B87400` |
| `--accent-hover` | `#996100` |
| `--accent-dim` | `#FDF3E0` |
| `--success` | `#1A7F37` |
| `--warning` | `#9A6700` |
| `--danger` | `#CF222E` |
| `--info` | `#0969DA` |

Implementation: the full light palette is defined on bare `:root`; dark values are redefined inside `@media (prefers-color-scheme: dark)` and again under `[data-theme="dark"]` so an explicit toggle wins in both directions. Every colour has a definition on bare `:root` — no colour exists only inside a media query.

### Semantic use

| Meaning | Colour |
| --- | --- |
| Cache hit / healthy / created | `--success` |
| Cache miss / neutral info | `--info` |
| Rate limited / degraded | `--warning` |
| Error / unhealthy | `--danger` |
| Interactive / brand | `--accent` |

Contrast: all body text meets WCAG AA (≥ 4.5:1); large text and UI boundaries meet ≥ 3:1. Colour is never the sole carrier of meaning — status also gets a label and a shape.

## 3. Typography

### Families

```css
--font-mono: "JetBrains Mono", "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
--font-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
```

Monospace carries the identity: headings, codes, URLs, metrics, buttons, labels. Sans-serif is for prose — descriptions and help text — where monospace would slow reading.

Fonts load from Google Fonts with a full local fallback stack, so the page is correct before and without the webfont.

### Scale

A 1.25 ratio on a 16 px base.

| Token | Size | Weight | Tracking | Use |
| --- | --- | --- | --- | --- |
| `--fs-display` | 39 px | 700 | −0.02em | Wordmark |
| `--fs-h1` | 31 px | 700 | −0.02em | Page title |
| `--fs-h2` | 25 px | 600 | −0.01em | Section |
| `--fs-h3` | 20 px | 600 | 0 | Card title |
| `--fs-body` | 16 px | 400 | 0 | Body |
| `--fs-sm` | 14 px | 400 | 0 | Secondary |
| `--fs-xs` | 12.5 px | 500 | 0.03em | Labels, badges, metrics |

Line height: 1.2 for headings, 1.6 for body, 1.4 for dense tabular rows. Measure is capped at 68 characters for prose. Labels are uppercase with `0.08em` tracking; body text is never uppercased.

Numerals use `font-variant-numeric: tabular-nums` everywhere a value can change, so digits do not jitter on update.

## 4. Space and layout

A strict 4 px base scale: `--sp-1: 4px` through `--sp-12: 64px` (4, 8, 12, 16, 20, 24, 32, 40, 48, 56, 64).

- Page max width `1100px`, centred, `--sp-6` (24 px) gutters.
- Cards: `--sp-6` padding, `--sp-5` (20 px) internal gaps.
- Related elements sit `--sp-2` apart; sections `--sp-9` apart.
- Radii: `--r-sm: 4px` (badges, inputs), `--r-md: 8px` (cards, buttons), `--r-lg: 12px` (modals). Nothing fully rounded — pills read as consumer-app, which this is not.
- Borders are 1 px hairlines. Elevation comes from background steps (`--bg` → `--surface` → `--surface-2`), not shadows. The single exception is a focused/active card, which gets `--border-strong`.

## 5. Components

**Input** — `--surface-2` fill, 1 px `--border`, `--r-sm`, 12/16 px padding, monospace. Focus: `--border-strong` plus a 2 px `--accent` outline at 40% opacity, never `outline: none` alone.

**Button (primary)** — `--accent` fill, `--bg` text, `--r-md`, 12/20 px padding, mono 600, uppercase, `0.05em` tracking. Hover `--accent-hover`; active shifts down 1 px; disabled drops to 40% opacity with `cursor: not-allowed`.

**Button (ghost)** — transparent fill, 1 px `--border`, `--text-dim` text. Hover raises the border to `--border-strong` and the text to `--text`.

**Card** — `--surface` on `--bg`, 1 px `--border`, `--r-md`, `--sp-6` padding. Optional header row: uppercase `--fs-xs` label in `--text-dim`, hairline below.

**Badge** — `--fs-xs`, uppercase, `--r-sm`, 2/8 px padding, semantic colour at 15% opacity for the fill and full strength for the text. Used for `HIT` / `MISS` / `201` / `429`.

**Result panel** — appears after a create. Shows the short URL in `--fs-h3` monospace with a copy button, then a metrics row: latency in ms, cache tier badge, and shard number. This panel is the emotional payoff of the UI; it gets the accent border.

**Stat tile** — uppercase `--fs-xs` label above a `--fs-h2` tabular-nums value. Tiles sit in a responsive grid, minimum 160 px per column.

**Toast** — bottom-right, `--surface` with a 3 px semantic left border, auto-dismiss at 3 s, dismissible sooner. Used for copy confirmation and errors.

## 6. Motion

Fast and functional. Nothing that makes a user wait for the interface after waiting for the network.

| Token | Duration | Curve |
| --- | --- | --- |
| `--t-fast` | 120 ms | `cubic-bezier(0.4, 0, 0.2, 1)` |
| `--t-base` | 200 ms | `cubic-bezier(0.4, 0, 0.2, 1)` |

Transition only `background-color`, `border-color`, `color`, `opacity`, and `transform` — never `width`, `height`, or `box-shadow`. Result panels enter with an 8 px rise plus fade over `--t-base`. The loading state is a 1.5 s pulse on the button label, not a spinner.

Everything is wrapped in `@media (prefers-reduced-motion: reduce)`, which sets all durations to `0.01ms`.

## 7. Responsive

Mobile-first, three breakpoints: `640px` (tablet), `1024px` (desktop), `1280px` (wide).

- Below 640 px: single column, full-width controls, stat tiles at 2-up, `--sp-4` gutters.
- 640–1024 px: two-column stat grid, form stays single column.
- Above 1024 px: form and result side by side, stat tiles at 4-up.

Tables and code blocks always scroll inside their own `overflow-x: auto` container. The page body never scrolls horizontally.

## 8. Accessibility

- Every interactive element has a visible focus ring: 2 px `--accent` at 2 px offset. Focus is never removed, only restyled.
- All inputs have real `<label>` elements, not placeholder-as-label.
- The result panel and the toast region are `aria-live="polite"` so screen readers announce a created link.
- Full keyboard operability, logical tab order, and a skip link to main content.
- Touch targets are at least 44 × 44 px.
- Status is conveyed by text and shape as well as colour.

## 9. Voice

Terse, technical, honest. Lowercase for hints and helper text; sentence case for messages.

| Instead of | Write |
| --- | --- |
| "Oops! Something went wrong 😅" | "Create failed — 503. The database is unavailable." |
| "Your awesome link is ready! 🎉" | "Created in 4 ms · shard 2" |
| "Slow down there!" | "Rate limited. 47 s until reset." |

No exclamation marks. No emoji in the product UI. Errors state what failed, the status, and what to do next.
