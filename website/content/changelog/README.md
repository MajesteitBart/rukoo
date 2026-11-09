# Changelog entries

One `.mdx` file per version, as in the PersonalBlog (bvdm.ai) blog.
The file name is the slug: `YYYY-MM-DD-v<version>.mdx`, for example
`2026-11-03-v2.3.0.mdx`. Rukoo Voice uses `voice-v<version>`.

Frontmatter:

```yaml
---
title: "Short headline in sentence case"
description: "One sentence that says what changed for users."
date: "2026-11-03T14:41:00Z"
version: "2.3.0"
release: "https://github.com/MajesteitBart/rukoo/releases/tag/v2.3.0"
image: "/img/changelog/<first screenshot>.png"
draft: false
---
```

Write the body in plain English for people who do not build software.
Plain markdown only: no raw HTML and no components. The builder rejects both.

Screenshots use sample data only. Put the PNG in
`assets-src/changelog/`, add its GitHub origin to
`assets-src/changelog/sources.json`, and write it as
`![alt text](/img/changelog/<name>.png)` with the caption as the next
paragraph in italics, linking the GitHub issue it came from.

Then build and commit the result with the entry:

```sh
npm run changelog:images
npm run changelog
```

Entries sort newest first by `date`. A `draft: true` entry is left out.
