# epic-dashboard-psi DESIGN.md

> Auto-generated design system — reverse-engineered via static analysis by skillui.
> Frameworks: None detected
> Colors: 20 · Fonts: 3 · Components: 0
> Icon library: not detected · State: not detected
> Primary theme: light · Dark mode toggle: no · Motion: none

---

## 1. Visual Theme & Atmosphere

This is a **light-themed** interface with a cool, approachable feel. The light background emphasizes content clarity. Typography pairs **Geist** for display/headings with **Roboto** for body text, creating clear visual hierarchy through type contrast. Spacing follows a **4px base grid** (compact density), with scale: 4, 6, 8, 10, 12, 16, 20, 24px. The accent color **#007bff** anchors interactive elements (buttons, links, focus rings).

---

## 2. Color Palette & Roles

| Token | Hex | Role | Use |
|---|---|---|---|
| tw-ring-offset-color | `#ffffff` | background | Page background, darkest surface |
| color-red-50 | `#fef2f2` | surface | Card and panel backgrounds |
| text-primary | `#141414` | text-primary | Headings and body text |
| text-muted | `#5c6873` | text-muted | Captions, placeholders, secondary info |
| border | `#212529` | border | Dividers, card borders, outlines |
| accent | `#007bff` | accent | CTAs, links, focus rings, active states |
| danger | `#f26522` | danger | Error states, destructive actions |
| color-emerald-50 | `#ecfdf5` | success | Success states, positive indicators |
| color-amber-100 | `#fef3c6` | warning | Warning states, caution indicators |
| color-slate-900 | `#0f172b` | info | Informational highlights |
| color-red-100 | `#ffe2e2` | unknown | Palette color |
| color-red-200 | `#ffcaca` | unknown | Palette color |
| color-red-600 | `#e40014` | unknown | Palette color |
| color-red-700 | `#bf000f` | unknown | Palette color |
| color-red-800 | `#9f0712` | unknown | Palette color |
| color-amber-200 | `#fee685` | unknown | Palette color |
| color-amber-600 | `#dd7400` | unknown | Palette color |
| color-amber-700 | `#b75000` | unknown | Palette color |
| color-amber-900 | `#7b3306` | unknown | Palette color |
| color-emerald-100 | `#d0fae5` | unknown | Palette color |

### CSS Variable Tokens

```css
--tw-border-style: solid;
--primary: #007bff;
--secondary: #6c757d;
```


---

## 3. Typography Rules

**Font Stack:**
- **Roboto** — Heading 1, Heading 2, Heading 3
- **Geist** — Body, Caption
- **Geist Mono** — Code

**Font Sources:**

```css
@font-face {
  font-family: "Geist";
  src: url("https://epic-dashboard-psi.vercel.app/_next/static/immutable/media/fef07dbb0973bf53-s.00az9qtie3ho1.woff2") format("woff2");
  font-weight: 100;
}
@font-face {
  font-family: "Geist Mono";
  src: url("https://epic-dashboard-psi.vercel.app/_next/static/immutable/media/5ce348bf30bf5439-s.27spqqad3wyeo.woff2") format("woff2");
  font-weight: 100;
}
@font-face {
  font-family: "Roboto";
  src: url("https://epic-dashboard-psi.vercel.app/fonts/Roboto/Roboto-Black.ttf") format("truetype");
  font-weight: 400;
}
@font-face {
  font-family: "Noto Sans";
  src: url("https://epic-dashboard-psi.vercel.app/fonts/Noto_Sans/NotoSans-Bold.ttf") format("truetype");
  font-weight: 400;
}
```

| Role | Font | Size | Weight |
|---|---|---|---|
| Heading 1 | Roboto | 14px | 700 |
| Heading 2 | Roboto | 11px | 700 |
| Heading 3 | Roboto | 10px | 700 |
| Body | Geist | inherit | 400 |
| Caption | Geist | 1em | 400 |
| Code | Geist Mono | 14px | 400 |

**Typographic Rules:**
- Limit to 3 font families max per screen
- Use **Roboto** for body/UI text, **Geist** for display/headings
- Maintain consistent hierarchy: no more than 3-4 font sizes per screen
- Headings use bold (600-700), body uses regular (400)
- Line height: 1.5 for body text, 1.2 for headings
- Use color and opacity for secondary hierarchy, not additional font sizes


---

## 4. Component Stylings

No components detected. Scan `src/components/` or `components/` to populate this section.

---

## 5. Layout Principles

- **Base spacing unit:** 4px
- **Spacing scale:** 4, 6, 8, 10, 12, 16, 20, 24, 30, 32, 40, 64
- **Border radius:** .25rem, 6px, 8px, 12px, 20px, 20px 0px 0px 20px

**Spacing as Meaning:**
| Spacing | Use |
|---|---|
| 4-8px | Tight: related items within a group |
| 12-16px | Medium: between groups |
| 24-32px | Wide: between sections |
| 48px+ | Vast: major section breaks |


---

## 6. Depth & Elevation

### Raised — cards, buttons, interactive elements

- `rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.1) 0px 1px 3px 0px, rgba(0, 0, 0, 0.1) 0px 1px 2px -1px`
- `rgba(0, 0, 0, 0.06) 0px 1px 2px 0px, rgba(0, 0, 0, 0.06) 0px -1px 4px 0px`



---

## 8. Do's and Don'ts

### Do's

- Use `#007bff` for interactive elements (buttons, links, focus rings)
- Use `#ffffff` as the primary page background
- Pair **Roboto** (body) with **Geist** (display) — these are the only allowed fonts
- Follow the **4px** spacing grid for all margins, padding, and gaps
- Use the defined shadow tokens for elevation — see Section 6
- Use border-radius from the scale: .25rem, 6px, 8px, 12px, 20px

### Don'ts

- Don't introduce colors outside this palette — extend the design tokens first
- Don't introduce additional font families beyond Roboto and Geist and Geist Mono
- Don't use arbitrary spacing values — stick to multiples of 4px
- Don't create custom box-shadow values outside the system tokens
- Don't use gradients — the design uses solid colors only
- Don't use arbitrary border-radius values — pick from the defined scale
- Don't use backdrop-blur or blur effects

### Anti-Patterns (detected from codebase)

- No gradient backgrounds
- No blur or backdrop-blur effects
- No zebra striping on tables/lists


---

## 9. Responsive Behavior

| Name | Value | Source |
|---|---|---|
| sm | 40rem | css |
| md | 48rem | css |
| lg | 64rem | css |
| xl | 80rem | css |

**Approach:** Use `@media (min-width: ...)` queries matching the breakpoints above.


---

## 10. Agent Prompt Guide

Use these as starting points when building new UI:

### Build a Card

```
Background: #fef2f2
Border: 1px solid #212529
Radius: 12px
Padding: 16px
Font: Roboto
Use shadow tokens from Section 6.
```

### Build a Button

```
Primary: bg #007bff, text white
Ghost: bg transparent, border #212529
Padding: 8px 16px
Radius: 12px
Hover: opacity 0.9 or lighter shade
Focus: ring with #007bff
```

### Build a Page Layout

```
Background: #ffffff
Max-width: 1280px, centered
Grid: 4px base
Responsive: mobile-first, breakpoints from Section 9
```

### Build a Stats Card

```
Surface: #fef2f2
Label: #5c6873 (muted, 12px, uppercase)
Value: #141414 (primary, 24-32px, bold)
Status: use success/warning/danger from Section 2
```

### Build a Form

```
Input bg: #ffffff
Input border: 1px solid #212529
Focus: border-color #007bff
Label: #5c6873 12px
Spacing: 16px between fields
Radius: 12px
```

### General Component

```
1. Read DESIGN.md Sections 2-6 for tokens
2. Colors: only from palette
3. Font: Roboto, type scale from Section 3
4. Spacing: 4px grid
5. Components: match patterns from Section 4
6. Elevation: shadow tokens
```
