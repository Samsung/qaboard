# Writing the QA-Board docs

Rules for everything under `website/` (docs, landing page, blog, release notes) and the text in the web app that
points to it. Agents and people follow the same rules; reviewers check them.

## Readers
The docs have one sidebar per audience (`website/sidebars.ts`):
- **User guide** (`user-guide/`): engineers who look at results in the web app.
- **Project integration**: whoever wraps a project with `qa`: *qaboard.yaml*, metrics, visualizations, runners, CI.
- **Admin** (`backend-admin/`): whoever runs the server.

Know which one you're writing for, and link to the others instead of mixing them. When a change affects how people
use the web app, update the user guide in the same PR.

## Voice
- **Confident and concrete.** Say what the reader can do and what they'll see: "Hover a point to see its commit", not
  "QA-Board offers powerful hover capabilities".
- **Second person, present tense, active voice.** "You", "QA-Board shows". "We" only for the maintainers' plans, on
  the roadmap page and the blog.
- **Short sentences, one idea each.** Lead with the point; details after.
- **Write for the reader, not the committer** (the release notes' rule, see `CLAUDE.md`): what changed for them, not
  how it was built. In release notes, one change per bullet, starting with a verb.
- **No hype:** no "powerful", "seamless", "blazing", "revolutionary", "magic", "best-in-class", "game-changing".
- **No "simply", "just", "easy", "obviously", "of course", "note that", "please".** If it's easy, the reader will
  see; if it isn't, they'll feel bad.
- US English. Sentence-case headings. No exclamation marks.

## Terminology
Name things the way the web app does, and the same way every time.

| Use | Not | |
|---|---|---|
| QA-Board | QABoard, Qa-Board | `qaboard` only for the Python package |
| the web app | the UI, the GUI, the web application, the webapp | |
| `qa` | qatools | the CLI |
| *qaboard.yaml* | qatools.yaml | file names of documents in italics |
| run | output, job | "output files" are what a run writes |
| batch, the CI batch | | the CI batch has the label `default` and is shown as **CI** |
| input | test case, sample | "test" for an input with its configuration, as in **Available Tests** |
| configuration | config | `configs` only as the YAML key |
| metric | KPI, figure of merit | the views were renamed from "KPIs" |
| target | threshold, goal | |
| new, reference | ref | `ref` only when quoting the app |
| milestone (shared or private) | bookmark, baseline | |
| reference branch | master branch | |
| tuning, a tuning experiment, automated tuning | auto-tuning, hyper-parameter search | automated tuning is `qa optimize` |
| quality gate, `qa gate` | | Experimental, see below |
| results review | experiment tracking | how we describe the product |
| self-hosted | on-prem | |

**UI labels** are written exactly as the app shows them, in bold. The source of truth is the code
(`webapp/src/AppSider.jsx` for the sidebar); `SIDEBAR.md` documents how the sidebar is organized.

- Commit page sections and views: **Metrics** (**Summary**, **Metrics Table**, **Metrics Diff**), **Outputs**
  (**Visualizations**, **Output Files**, **Logs**), **Source** (**Artifacts & Configs**, **Code**), **Tuning**
  (**Available Tests**, **Run Tests / Tuning**, **Analysis**).
- Elsewhere: **History**, **Milestones**, **Integrations** (formerly "Actions & Links"), the **Controls** panel,
  **Image Diff**, **Dynamic Options**, **What's new**, the file browser.
- `SIDEBAR.md` writes "Run Tests/Tuning"; the app writes **Run Tests / Tuning**: follow the app.

## Claims
**Every claim about the product can be seen in a screenshot or verified in the code on `master`.**

- Before writing "you can", find the code that does it. If you can't, don't write it.
- In the PR description, list the feature claims you added with where they're implemented (`path:line`, or a shot id).
  The claims reviewer checks them.
- Numbers come from measurements or the demo data, never from memory: "a 113 MP image", not "huge images".
- Describe what the code does today, not what it should do. A known gap is stated plainly ("GitHub-hosted runners
  can't reach the results storage yet"), with a link to the roadmap.
- Comparisons with other tools are fair and dated: what they're great at, then where QA-Board differs.

### Experimental features
Features that may change without notice (`qa optimize` today, the quality gate when it ships) are marked everywhere:
- a `:::caution Experimental` admonition at the top of their page or section, saying what may change;
- the word "experimental" in their release note;
- no use on the landing page without the label.

### The roadmap
Unshipped work lives on the roadmap page only, with its status: **Shipped**, **Experimental**, **Next**,
**Exploring**. Elsewhere, at most one sentence that links to it ("Not yet: see the [roadmap](/docs/roadmap)"), never
in the present tense. The landing page only claims Shipped and Experimental items.

## Screenshots and clips
- **Use the components:** `<Shot id="...">`, `<Clip id="...">`, `<Compare before="..." after="...">`, with ids from
  `docs-media/shots.yaml` (see `docs-media/README.md`). Props are literal strings. Don't add app screenshots to
  `website/static/img/`: they rot, and the build can't check them.
- **Only the demo world:** screenshots show the Kitefin projects (`examples/README.md`), never real projects, people,
  hosts or paths. No error states, spinners or empty pages unless that's the point.
- **A caption says what to notice,** not what the picture is:
  - Yes: "The p99 line jumps at the commit that copied payloads; hovering it shows that commit's cards."
  - No: "The History page."
- **Alt text says what's there,** for someone who can't see it: the view, the state that matters, the key values.
  One or two sentences, no "screenshot of", no file names, no repeat of the caption. Clips: describe the action
  ("Zooming into the image; the reference follows, then Image Diff turns on").
- **Call-outs:** at most 4, labeled with the UI's names, anchored to elements recorded by the shot (`anchor`), not to
  pixel positions, when possible.
- Put the shot right after the paragraph it illustrates. One shot per idea; a clip when the point is a motion (sync,
  hover, live updates), a still otherwise.

## Links
- To a doc page: `[text](/docs/page-id)`, with the page's id (its frontmatter `id`, prefixed by its folder:
  `/docs/user-guide/commit-page`, `/docs/visualizations`). Add `#heading-id` for a section.
- The ids the web app links to never change: `user-guide/overview`, `user-guide/files`, `visualizations`,
  `computing-quantitative-metrics`, `installation`, `triggering-third-party-tools`,
  `batches-running-on-multiple-inputs`, `celery-integration`, `auto-optimization`. A moved page keeps its id or gets a
  redirect.
- Link text says where it goes: "see [Batches of inputs](/docs/batches-running-on-multiple-inputs)", never "click
  here".
- To the repository: `https://github.com/Samsung/qaboard/...`; images: `ghcr.io/samsung/qaboard`. The docs site is
  `samsung.github.io/qaboard`.
- External links go to stable public pages.

## Admonitions
| Kind | For |
|---|---|
| `:::note` | Side information the reader can skip |
| `:::tip` | A shortcut or a better way |
| `:::info` | Context needed before the steps, like prerequisites |
| `:::caution` | A pitfall: something that silently gives wrong results, or Experimental |
| `:::danger` | Data loss, security, irreversible actions |

At most one per section, never two in a row. A title only when it adds information (`:::caution Experimental`).

## Code blocks
- Always a language: `bash`, `yaml`, `python`, `text` for output.
- Files get a title with their path: ` ```yaml title="qaboard.yaml" `. Highlight what matters with `{3-5}`.
- Shell blocks hold commands only, without a `$` prompt, so they can be copied. Show output in a separate `text`
  block.
- Placeholders look like `<your-qaboard>` and are explained right after the block.
- A snippet that shows a file of the repository is that file: `<RepoFile path="charts/qaboard/kind.yaml" />`
  imports it at build time, so it can't drift (`lines="3-10"` shows a part, `title` names it for the reader).
- CI configurations that no CI of ours runs (GitLab CI, Jenkins, the reader's GitHub Actions workflow) are files in
  `website/snippets/`, shown with `<RepoFile ... untested />`, which says "Not run in our CI". The website
  workflow lints the GitHub Actions ones (`github-actions*.yml`) with actionlint.
- Lines under 100 characters when possible.

## Tabs and the stack picker
- The quickstart and the tutorials start with `<StackPicker />`. It sets every tab group of the site at once, and
  links carry the choice (`?server=k8s&ci=github-actions`).
- Tabs that depend on the reader's stack use the shared groups and values from `website/src/components/stack.ts`:
  `<Tabs groupId="ci" queryString>` with `<TabItem value="github-actions" label="GitHub Actions" default>`.
  Groups: `server`, `forge`, `ci`, `runner`, `code`. The GitHub option is the default. `<StackPicker>`, `<Tabs>`
  and `<TabItem>` need no import.
- The build fails on a stack tab group without `queryString`, an unknown value, a label that differs from
  `stack.ts`, or `default` on another value than the group's default.
- `<StackPicker groups={['server', 'ci']} />` shows only some groups, `compact` makes it one line.
- Every tab of a group has the same steps in the same order; only the content differs.
- Don't nest tabs, and don't use tabs for one differing line: write a sentence.

## What never goes in
- Internal hostnames, IPs, paths, registries or runbooks of any company. Examples use `localhost:5151`,
  `<your-qaboard>`, `kitefin.example`, and `/mnt/qaboard`.
- Names of real people (colleagues, users, customers), except credited quotes with their permission.
- Ticket, issue or merge request ids from internal trackers, commit shas.
- Secrets, tokens, personal emails.

## Page checklist
- Frontmatter: `id`, `title`, `sidebar_label`, and a one-sentence `description`.
- The first paragraph says what the page helps the reader do.
- Task pages use numbered steps, one action each, with the expected result.
- `yarn build` passes: no broken links, no unknown shot ids.
