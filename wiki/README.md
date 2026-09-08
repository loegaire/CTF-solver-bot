# Wiki sources

The GitHub **wiki** for this repo is rendered from the Markdown files in this
directory. Each file is one wiki page.

## Pages

| File | Wiki page |
| --- | --- |
| [`Home.md`](Home.md) | Home — overview + doc map |
| [`Core-Architecture.md`](Core-Architecture.md) | Core Architecture |
| [`Source-of-Truth-and-Orchestration.md`](Source-of-Truth-and-Orchestration.md) | Source of Truth and Orchestration |
| [`Persistence-and-Database.md`](Persistence-and-Database.md) | Persistence and Database |
| [`Job-Lifecycle.md`](Job-Lifecycle.md) | Job Lifecycle |
| [`Outcome-Classification.md`](Outcome-Classification.md) | Outcome Classification |
| [`Agent-Backends.md`](Agent-Backends.md) | Agent Backends |
| [`Discord-Integration.md`](Discord-Integration.md) | Discord Integration |
| [`Configuration-Reference.md`](Configuration-Reference.md) | Configuration Reference |
| [`Deployment-and-Operations.md`](Deployment-and-Operations.md) | Deployment and Operations |
| [`Testing.md`](Testing.md) | Testing |
| `_Sidebar.md` | Wiki sidebar |

## Publishing to the GitHub wiki

The wiki's backing git repo (`CTF-solver-bot.wiki.git`) **does not exist
until the first page is saved once via the web UI** — GitHub has no API to
initialize it. So the one-time manual bootstrap is:

1. Open <https://github.com/loegaire/CTF-solver-bot/wiki>
2. Click **Create the first page**, type anything, **Save**.

After that, the wiki is a normal git repo and this directory is the source:

```bash
# manual sync (from repo root):
rm -rf /tmp/w && mkdir /tmp/w && cd /tmp/w
git init -q -b master
cp "$OLDPWD"/wiki/*.md .
git add -A
git commit -m "sync wiki pages"
git push git@github.com:loegaire/CTF-solver-bot.wiki.git master:master
```

A [`workflow_dispatch`](../actions/workflows/init-wiki.yml) GitHub Actions
workflow (`.github/workflows/init-wiki.yml`) automates the same push on
demand and on every change to `wiki/**` — it requires a repository secret
`WIKI_PAT` (classic PAT with `repo` scope).

## Conventions

- Wiki pages use GitHub wiki-style `[[Page-Name]]` cross-links (they work in
  the wiki rendering; in-repo GitHub renders them as plain text).
- The sidebar (`_Sidebar.md`) lists every page.
- Keep documentation changes in sync with the code: the wiki pages reference
  concrete modules (`src/...`) and behaviors that the tests pin down.
