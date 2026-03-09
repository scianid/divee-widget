# Widget Hover Effect — AI Magic Button

## Design Philosophy

The effect should **signal interactivity and premium quality** without competing with the page content or feeling like a browser notification. The guiding rule: only one layer animates continuously — everything else reacts once on hover entry, then settles.

---

## Overview

On hover, **5 layers activate**, 4 of which settle after their entry animation. Only the shimmer can optionally loop slowly.

---

## Layer Breakdown

### 1. Lift + Box Shadow *(base — most impactful)*
Applied directly via CSS. Instantly signals the element is interactive.

```css
.ai-magic-button:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow:
    0 0 12px rgba(168, 85, 247, 0.45),   /* purple glow */
    0 0 24px rgba(34, 211, 238, 0.25);   /* cyan glow — kept soft */
  transition: transform 200ms ease, box-shadow 200ms ease;
}
```

> Glow values kept **lower than originally spec'd** (0.45 / 0.25 vs 0.6 / 0.4) so they read as a halo, not a spotlight.

---

### 2. Static Gradient Border
- A **1.5px gradient border** (purple → cyan → purple) drawn via a pseudo-element with an inner mask cutout.
- **No animation** — the gradient is fixed. Motion on a border border fights the button's own content.

```css
.ai-magic-button::before {
  content: '';
  position: absolute;
  inset: -1.5px;
  border-radius: inherit;
  background: linear-gradient(135deg, #a855f7, #22d3ee, #a855f7);
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  opacity: 0;
  transition: opacity 250ms ease;
}
.ai-magic-button:hover:not(:disabled)::before {
  opacity: 1;
}
```

---

### 3. Inner Prismatic Glow
- **Two `radial-gradient` ellipses** inside the button:
  - Purple at **top-left**
  - Cyan at **bottom-right**
- Fade to **35% opacity** on hover (down from 60% — less muddy).
- Applied via a second pseudo-element or background-image layer.

---

### 4. Shimmer Sweep *(the one moving element)*
- A single **translucent white `linear-gradient` stripe** sweeps left-to-right once on hover entry.
- Transform: `translateX(-100%) → translateX(200%)`
- Duration: **0.8s**, `ease-in` — snappy entry, tapers off.
- Does **not loop** by default; can be set to repeat every 4–5s if a recurring "pulse" is desired.

```css
@keyframes ai-shimmer {
  from { transform: translateX(-100%) skewX(-15deg); }
  to   { transform: translateX(300%) skewX(-15deg); }
}
```

---

### 5. Particle Drift *(subtle, not looping)*
- **3 tiny white `2×2` dots** (reduced from 8) scattered within the button.
- Triggered once on hover entry — drift upward ~8px and fade to 0 over **1.2s**.
- Stagger: **120ms** apart.
- Particles do **not** re-trigger while button stays hovered.

```css
@keyframes ai-particle-drift {
  0%   { transform: translateY(0);    opacity: 0.7; }
  100% { transform: translateY(-8px); opacity: 0; }
}
```

---

### 6. Icon Scale
- The sparkle icon scales up: `scale(1.1)`
- Transition: **300ms ease**
- Small and purposeful — the only transform on the icon.

---

## What Was Removed and Why

| Layer | Reason Removed |
|---|---|
| Outer cosmic glow (animated blur) | Shifting blur radius reads as a rendering glitch |
| Animated rainbow border (looping) | Continuous border motion competes with button content |
| Floating orbs (bobbing) | Adds perpetual motion that never resolves; distracting |

---

## Keyframe Summary

| Keyframe            | Duration | Loops? | Effect                                         |
|---------------------|----------|--------|------------------------------------------------|
| `ai-shimmer`        | 0.8s     | No     | White stripe sweeps left-to-right once         |
| `ai-particle-drift` | 1.2s     | No     | 3 dots drift up and fade, 120ms stagger        |

---

## Layer Order (paint order)

1. Gradient border pseudo-element (behind content)
2. Inner prismatic glow (background layer)
3. Lift + box-shadow (element transform)
4. Shimmer sweep (overlay)
5. Particle drift (scattered children)
6. Icon scale (icon element)
