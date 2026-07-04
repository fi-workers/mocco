# docs/prototype/ — click-through for design validation (⚠️ not real code)

> [!warning] This is a prototype
> What lives here is a **non-functional** HTML/CSS/light-JS click-through.
> It's a **throwaway artifact** for eyeballing the product design, screen flow, and UX and folding in feedback.

## Absolute rules

1. **Never mix it with real implementation code.** Future real code goes in the repo root's `src/` (planned), and this `prototype/` stays fully separate from it.
2. **Mock data only.** No backend calls, no DB, no real auth, no real GitHub API calls. Everything on screen is static JSON from `mock/` or hardcoded.
3. **Don't trust the logic.** Buttons only *pretend* to click and screens only *pretend* to transition. No approval, verification, or deploy actually happens.
4. **It can be thrown away.** Once the design is settled, this directory is either scrapped wholesale or archived into `docs/`. Do not copy-paste code from here into the real implementation.

## Structure (planned)

```
prototype/
├── README.md          # this file
├── index.html         # entry point (screen navigation)
├── styles/            # shared CSS (design system)
├── screens/           # per-screen HTML
├── mock/              # static mock data (JSON)
└── shots/             # review screenshots
```

## Running

Static files, so no build needed. Open it locally to review:

```bash
# from the root
python3 -m http.server -d prototype 8080
# → http://localhost:8080
```

## Change log

The prototype's evolution and the feedback folded into it are recorded in `../docs/journal/`. (This directory holds only code.)
