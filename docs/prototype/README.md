# docs/prototype/ — click-through for design validation (⚠️ not real code)

> [!warning] This is a prototype
> What lives here is a **non-functional** HTML/CSS/light-JS click-through.
> It's a **throwaway artifact** for eyeballing the product design, screen flow, and UX and folding in feedback.

## Absolute rules

1. **Never mix it with real implementation code.** Future real code goes in the repo root's `src/` (planned), and this `prototype/` stays fully separate from it.
2. **Mock data only.** No backend calls, no DB, no real auth, no real GitHub API calls. Everything on screen is static JSON from `mock/` or hardcoded.
3. **Don't trust the logic.** Buttons only *pretend* to click and screens only *pretend* to transition. No approval, verification, or deploy actually happens.
4. **It can be thrown away.** Once the design is settled, this directory is either scrapped wholesale or archived into `docs/`. Do not copy-paste code from here into the real implementation.

## Structure

```
docs/prototype/
  index.html      # entry — open directly or serve statically
  app.js          # hash router + renderers (all mock)
  styles/app.css
  mock/data.js    # window.MOCK — fictional data only
```

## Running

Static files, so no build needed. Open it locally to review:

```bash
# from the repo root (or just open index.html directly in a browser — file:// works)
python3 -m http.server -d docs/prototype 8080
# → http://localhost:8080
```

## Change log

The prototype's evolution and the feedback folded into it are recorded in `the repo CHANGELOG`. 
