## What and why

<!-- What does this change, and why? Link related issues with "Fixes #123". -->

## How I tested it

<!-- For example: ran the wiki locally with `pwsh ./scripts/wiki.ps1 up`, re-seeded, checked pages X and Y. -->

## Checklist

- [ ] If I changed `tools/gen-entities/entities.js`, `de.js` or `samples.js`, I ran
      `node tools/gen-entities/generate.js` and `node tools/gen-entities/samples.js` and committed the output.
      I did not edit generated files by hand.
- [ ] The checks from [CONTRIBUTING.md](https://github.com/shiftbloom-studio/westernis/blob/main/CONTRIBUTING.md#checks) pass locally.
- [ ] Reader-facing wiki text is German and comes from `de.js` (labels) or the page sources; identifiers stay English.
- [ ] No `canon=Tolkien` facts were changed; no long verbatim Tolkien quotations (short quotes only, with source).
- [ ] No secrets, personal data, LAN addresses or local paths in the diff.
- [ ] Theme changes: screenshots attached (night and day mode), `?v=` / `WST_ASSET_VERSION` bumped where needed.
- [ ] I agree that my contribution is licensed under AGPL-3.0-or-later (code) and CC BY-SA 4.0 (wiki text).
