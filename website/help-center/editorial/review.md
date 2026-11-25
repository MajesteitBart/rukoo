# Review a documentation change

1. Read the latest release notes and held changes. Identify the product, stable/nightly channel, platform, version and release date. Require a released artifact or hosted-service release evidence for the behavior described. A Done ticket alone leaves the change held.
2. Search the private source map and page registry by task. Update existing pages first. Record a new page only for a distinct reader need; group multiple source changes into one task page where appropriate.
3. Keep the actual private source map outside the project. Validate it with `node scripts/check-source-map.mjs /absolute/private/map.json`. Use editorial/source-map.schema.json as the contract. The example is fictional and carries a held change.
4. Make a small content diff with exact UI labels, prerequisites and version scope. Use clean fictional data in screenshots. Keep unreleased behavior out of public content.
5. Run `npm ci && npm test && npm run build`. Inspect the preview, search results, changed links and mobile navigation. Product review follows every changed procedure on the named release; enter the date in behaviorChecked.
6. Open a PR with the public summary below. Put internal issue evidence and the source map in the private review channel. Request a product reviewer and an editorial reviewer; Daniel names those reviewers before phase 2 acceptance.

## Public PR body

- Reader task and why it changed.
- Existing page IDs and URLs changed; why a new page was necessary, if any.
- Public release sources and product/platform/version scope.
- Build/validation results and preview screenshots using sample data.
- Walkthrough date and result for changed steps.

## Private review record

Record source IDs, release evidence, mapping outcome, held items, product/editorial review and the last successful release checkpoint. Outcomes are update-existing, new-page, no-doc-change or hold. Keep a reason for exclusions and holds. Re-running the same sources should produce no duplicate pages or unnecessary edits.

Approval advances the reviewed checkpoint. Publication follows the eventual maintainer's release process. The weekly runner is phase 3 work; this scaffold defines its review contract.
