# Update Rukoo help

1. Read README.md, editorial/authoring.md and editorial/brand-and-tone.md.
2. Read the released source and the private source map supplied separately by the maintainer. A Done issue identifies work; a released version establishes availability.
3. Search page-registry.json and existing pages by user task. Update an existing page first. Preserve its pageId and URL.
4. Edit plain Markdown under src/content/docs/. Use the matching independent template from editorial/templates/ for a new user need. Replace every placeholder before validation. Register a new ID and URL explicitly.
5. Keep raw tickets, customer data, screenshots of real accounts and private review notes outside this tree. Allow only public product sources in page bodies and public metadata.
6. Run npm ci, npm test and npm run build. Preview with npm run preview -- --port 4321 and open http://127.0.0.1:4321/. Check changed pages, search and a phone-sized viewport. The help center is published at help.rukoo.io; link to other help pages by their registry URL, such as /mail/write/.
7. Open a reviewable PR as described in editorial/review.md. The product reviewer checks steps on the applicable release; the editorial reviewer checks the user need and wording. A maintainer handles publication.

Allowed content edits: src/content/docs/, navigation.json, page-registry.json and approved public assets. Toolchain changes need their own reviewed diff. Never read private inputs into Astro configuration or content loaders.
