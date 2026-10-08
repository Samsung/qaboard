#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "pyyaml>=6",
# ]
# ///
"""
Release notes tooling. The release notes are the Markdown files next to this script,
one per period: 2026-10.md (a month), 2025-q2.md (a quarter) or 2019.md (a year).
See _template.md and CLAUDE.md for how to write them.

  ./release_notes.py changelog 2026-09        # commits of the period, grouped by area
  ./release_notes.py draft 2026-10 --write    # new release note pre-filled from the commits
  ./release_notes.py check                    # validate the notes and their links to the docs

The web app shows the published notes (not `draft: true`) in its "What's new" panel: vite reads them when it
builds or serves the app (webapp/releaseNotes.js). The website renders them at /release-notes.
"""
import argparse
import calendar
import datetime
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

import yaml

NOTES_DIR = Path(__file__).resolve().parent
REPO_ROOT = NOTES_DIR.parent.parent
DOCS_DIR = REPO_ROOT / "website" / "docs"

PERIOD_RE = re.compile(r"^(?P<year>\d{4})(?:-(?:(?P<month>0[1-9]|1[0-2])|q(?P<quarter>[1-4])))?$")
AUDIENCES = ("users", "project-integration", "admins")
# The body's sections, in this order. Other headings are allowed but `check` warns about them.
SECTIONS = ("Web app", "CLI and project setup", "Server and administration", "Documentation", "Fixes", "Notes")
ALLOWED_KEYS = {"title", "date", "description", "version", "highlights", "draft", "period", "tags", "slug"}
HIGHLIGHT_KEYS = {"title", "description", "audience", "icon", "link"}


# ---------------------------------------------------------------- periods
@dataclass(frozen=True)
class Period:
    name: str  # 2026-10, 2025-q2, 2019
    start: datetime.date
    end: datetime.date  # exclusive
    title: str

    @property
    def last_day(self) -> datetime.date:
        return self.end - datetime.timedelta(days=1)


def parse_period(name: str) -> Period:
    name = name.lower()
    m = PERIOD_RE.match(name)
    if not m:
        raise ValueError(f"Invalid period '{name}': use YYYY-MM, YYYY-qN or YYYY")
    year = int(m["year"])
    if m["month"]:
        month = int(m["month"])
        start = datetime.date(year, month, 1)
        end = datetime.date(year + month // 12, month % 12 + 1, 1)
        title = f"{calendar.month_name[month]} {year}"
    elif m["quarter"]:
        q = int(m["quarter"])
        start = datetime.date(year, 3 * q - 2, 1)
        end = datetime.date(year + q // 4, (3 * q) % 12 + 1, 1)
        title = f"Q{q} {year}"
    else:
        start, end, title = datetime.date(year, 1, 1), datetime.date(year + 1, 1, 1), str(year)
    return Period(name, start, end, title)


# ---------------------------------------------------------------- changelog from git
# The first matching area wins. Order matters: the most user-visible areas come first.
AREAS = [
    ("Web app", ("webapp/",)),
    ("CLI and project setup", ("qaboard/", "qatools/", "tests/", "pyproject.toml", "uv.lock", "setup.py")),
    ("Backend", ("backend/",)),
    ("Server and administration", (
        "deployments/", "charts/", "services/", "docker-compose", "development.yml", "production.yml",
        ".github/", ".gitlab-ci.yml", "at-sirc", ".dockerignore",
    )),
    ("Documentation", ("website/", "docs/", "README", "CONTRIBUTING", "MIGRATION", "SECURITY", "CLAUDE.md")),
]
FIX_RE = re.compile(r"^(hot)?fix(ed|es|up)?\b|^bug|\bfix(es|ed)?\b", re.IGNORECASE)
NOISE_RE = re.compile(
    r"^(wip\b|fix(ed)? spaces|quick ?fix|test ?fix|fixup\b|typo|tmp\b|temp\b|cleanup$|clean ?up$|update$|"
    r"edit [\w.]+$|update file [\w./]+$|lint$|format(ting)?$|\.+$|-+$|merge\b|revert \"?wip)",
    re.IGNORECASE,
)


@dataclass
class Commit:
    sha: str
    date: datetime.date
    author: str
    subject: str
    files: list[str] = field(default_factory=list)

    @property
    def area(self) -> str:
        votes: dict[str, int] = {}
        for f in self.files:
            for area, prefixes in AREAS:
                if f.startswith(prefixes):
                    votes[area] = votes.get(area, 0) + 1
                    break
        if not votes:
            return "Other"
        # the first area that touches files: webapp changes are what users notice
        return next(area for area, _ in AREAS if area in votes)

    @property
    def is_fix(self) -> bool:
        return bool(FIX_RE.search(self.subject))

    @property
    def is_noise(self) -> bool:
        return len(self.subject) < 8 or bool(NOISE_RE.search(self.subject.strip()))


def git_commits(period: Period, rev: str = "HEAD") -> list[Commit]:
    # --since filters on the committer date, which is >= the author date: we then filter on the author date.
    # Without a time, git uses the current time of day. A day of margin for timezones.
    since = period.start - datetime.timedelta(days=1)
    out = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "log", rev, "--no-merges", f"--since={since.isoformat()}T00:00:00",
         "--format=%x00%H%x1f%ad%x1f%an%x1f%s", "--date=short", "--name-only"],
        capture_output=True, text=True, check=True,
    ).stdout
    commits = []
    for chunk in out.split("\x00")[1:]:
        header, _, files = chunk.partition("\n")
        sha, date, author, subject = header.split("\x1f", 3)
        day = datetime.date.fromisoformat(date)
        if period.start <= day < period.end:
            commits.append(Commit(sha, day, author, subject.strip(), [f for f in files.splitlines() if f]))
    if subprocess.run(["git", "-C", str(REPO_ROOT), "rev-parse", "--is-shallow-repository"],
                      capture_output=True, text=True).stdout.strip() == "true":
        print("WARNING: shallow clone, older commits are missing. Run: git fetch --unshallow", file=sys.stderr)
    return sorted(commits, key=lambda c: c.date)


def changelog_markdown(period: Period, commits: list[Commit], with_noise=True) -> str:
    kept = [c for c in commits if not c.is_noise]
    noise = [c for c in commits if c.is_noise]
    lines = [f"<!-- {len(commits)} commits from {period.start} to {period.last_day}"
             f" ({len(noise)} look like noise), grouped by the files they touch -->"]
    groups: dict[str, list[Commit]] = {}
    for c in kept:
        groups.setdefault("Fixes" if c.is_fix else c.area, []).append(c)
    for area in [a for a, _ in AREAS] + ["Other", "Fixes"]:
        if area not in groups:
            continue
        lines += ["", f"## {area}", ""]
        lines += [f"- {c.subject} <!-- {c.sha[:8]} {c.date} -->" for c in groups[area]]
    if noise and with_noise:
        lines += ["", "<!-- Skipped as noise:"] + [f"  {c.sha[:8]} {c.subject}" for c in noise] + ["-->"]
    return "\n".join(lines)


def draft_markdown(period: Period, commits: list[Commit]) -> str:
    frontmatter = {
        "title": period.title,
        "date": min(datetime.date.today(), period.last_day),
        "draft": True,
        "description": "TODO: one or two sentences: what changed for users this period.",
        "highlights": [{
            "title": "TODO: the most important change",
            "audience": "users",
            "icon": "star",
            "description": "TODO: what it is and why it matters, in 1-3 sentences.",
            "link": "/docs/introduction",
        }],
    }
    return "\n".join([
        "---",
        yaml.safe_dump(frontmatter, sort_keys=False, allow_unicode=True, width=120).strip(),
        "---",
        "<!-- truncate -->",
        "",
        "<!-- Draft generated from git: rewrite the commits as user-facing changes, merge related ones,",
        "     delete what users don't care about (refactors, CI, typos). Keep the sections that have content:",
        f"     {', '.join(SECTIONS)}. See _template.md -->",
        "",
        changelog_markdown(period, commits),
        "",
    ])


# ---------------------------------------------------------------- notes
@dataclass
class Note:
    path: Path
    meta: dict
    body: str

    @property
    def slug(self) -> str:
        return self.meta.get("slug") or self.path.stem

    @property
    def period(self) -> Period:
        return parse_period(self.meta.get("period") or self.path.stem)

    @property
    def draft(self) -> bool:
        return bool(self.meta.get("draft"))


def read_note(path: Path) -> Note:
    text = path.read_text(encoding="utf-8")
    m = re.match(r"^---\n(.*?)\n---\n?(.*)$", text, re.DOTALL)
    if not m:
        raise ValueError(f"{path.name}: missing the --- frontmatter ---")
    meta = yaml.safe_load(m[1]) or {}
    if isinstance(meta.get("date"), (datetime.date, datetime.datetime)):
        meta["date"] = meta["date"].isoformat()[:10]
    return Note(path, meta, m[2])


def note_paths() -> list[Path]:
    # Like docusaurus, files starting with _ are not release notes
    return sorted(p for p in NOTES_DIR.glob("*.md") if not p.name.startswith("_"))


def doc_urls() -> set[str]:
    """The URLs of the docs pages, e.g. /docs/backend-admin/deployment"""
    urls = set()
    for path in DOCS_DIR.rglob("*.md*"):
        text = path.read_text(encoding="utf-8")
        m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
        meta = (yaml.safe_load(m[1]) if m else None) or {}
        folder = path.parent.relative_to(DOCS_DIR).as_posix()
        folder = "" if folder == "." else folder + "/"
        slug = meta.get("slug")
        if slug:
            urls.add("/docs" + (slug if slug.startswith("/") else f"/{folder}{slug}").rstrip("/"))
        else:
            urls.add(f"/docs/{folder}{meta.get('id', path.stem.split('.')[0])}")
    return urls


def validate(note: Note, docs: set[str]) -> tuple[list[str], list[str]]:
    errors, warnings = [], []
    meta = note.meta
    try:
        note.period
    except ValueError as e:
        errors.append(str(e))
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(meta.get("date", ""))):
        errors.append("`date: YYYY-MM-DD` is required (the publication date)")
    if not meta.get("description"):
        errors.append("`description` is required: one or two sentences shown in the app and on the website")
    elif "TODO" in str(meta["description"]) and not note.draft:
        errors.append("the description still has a TODO")
    for key in set(meta) - ALLOWED_KEYS:
        warnings.append(f"unknown frontmatter key `{key}`")
    highlights = meta.get("highlights") or []
    if not isinstance(highlights, list):
        errors.append("`highlights` must be a list")
        highlights = []
    for i, h in enumerate(highlights):
        where = f"highlights[{i}]"
        if not isinstance(h, dict) or not h.get("title") or not h.get("description"):
            errors.append(f"{where}: `title` and `description` are required")
            continue
        if "TODO" in str(h) and not note.draft:
            errors.append(f"{where}: still has a TODO")
        for key in set(h) - HIGHLIGHT_KEYS:
            warnings.append(f"{where}: unknown key `{key}`")
        if h.get("audience") and h["audience"] not in AUDIENCES:
            errors.append(f"{where}: audience must be one of {', '.join(AUDIENCES)}")
        link = h.get("link")
        if link and not re.match(r"^(https?://|/docs/|/release-notes/)", link):
            errors.append(f"{where}: link must start with /docs/, /release-notes/ or http(s)://")
        elif link and link.startswith("/docs/") and link.split("#")[0].rstrip("/") not in docs:
            errors.append(f"{where}: no docs page at {link}")
    if len(highlights) > 5:
        warnings.append(f"{len(highlights)} highlights: keep the 2-4 most important ones")
    for link in re.findall(r"\]\((/docs/[^)\s#]*)", note.body):
        if link.rstrip("/") not in docs:
            errors.append(f"broken docs link {link}")
    for heading in re.findall(r"^## (.+)$", note.body, re.MULTILINE):
        if heading.strip() not in SECTIONS:
            warnings.append(f"section '## {heading.strip()}' is not one of: {', '.join(SECTIONS)}")
    if "<!-- truncate -->" not in note.body:
        warnings.append("missing `<!-- truncate -->` at the top of the body (the website lists only the highlights)")
    return errors, warnings


# ---------------------------------------------------------------- CLI
def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("changelog", help="the commits of a period, grouped by area, as markdown")
    p.add_argument("period", help="YYYY-MM, YYYY-qN or YYYY")
    p.add_argument("--rev", default="HEAD")
    p.add_argument("--no-noise", action="store_true", help="don't list the commits skipped as noise")
    p = sub.add_parser("draft", help="a new release note, pre-filled from the period's commits")
    p.add_argument("period", help="YYYY-MM, YYYY-qN or YYYY")
    p.add_argument("--rev", default="HEAD")
    p.add_argument("--write", action="store_true", help=f"create {NOTES_DIR.name}/<period>.md instead of printing")
    sub.add_parser("check", help="validate the notes and their links to the docs")
    args = parser.parse_args()

    if args.command in ("changelog", "draft"):
        period = parse_period(args.period)
        commits = git_commits(period, args.rev)
        if args.command == "changelog":
            print(changelog_markdown(period, commits, with_noise=not args.no_noise))
            return 0
        text = draft_markdown(period, commits)
        if not args.write:
            print(text)
            return 0
        path = NOTES_DIR / f"{period.name}.md"
        if path.exists():
            print(f"ERROR: {path} already exists", file=sys.stderr)
            return 1
        path.write_text(text, encoding="utf-8")
        print(f"Created {path.relative_to(REPO_ROOT)} ({len(commits)} commits)")
        return 0

    # check
    docs = doc_urls()
    n_errors = 0
    periods: dict[Period, Path] = {}
    for path in note_paths():
        try:
            note = read_note(path)
            errors, warnings = validate(note, docs)
            period = note.period
            for other, other_path in periods.items():
                if period.start < other.end and other.start < period.end:
                    errors.append(f"its period overlaps with {other_path.name}")
            periods[period] = path
        except Exception as e:  # noqa: BLE001 - report every broken file
            errors, warnings = [str(e)], []
        for w in warnings:
            print(f"WARNING {path.name}: {w}")
        for e in errors:
            print(f"ERROR   {path.name}: {e}")
        n_errors += len(errors)
    print(f"{len(periods)} release notes, {n_errors} errors")
    return 1 if n_errors else 0


if __name__ == "__main__":
    sys.exit(main())
