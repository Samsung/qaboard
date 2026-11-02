# Skills for coding agents

Skills that coding agents (Claude Code, and any agent that reads `SKILL.md` files) load to work with QA-Board in
*your* project. They are written for agents: terse, with the decisions to make and the checks to run, and they link to
the docs for the details.

| Skill | Use it when |
|---|---|
| [`qaboard-integration/`](qaboard-integration/SKILL.md) | Wrapping a project with `qa`: *qaboard.yaml*, the entrypoint's `run()`, metrics, visualizations, batches, CI and the quality gate. Also for changing an existing integration. |
| [`qaboard-results/`](qaboard-results/SKILL.md) | Reading results: the runs a web app page shows, from Python or the shell, comparing a commit with its reference, and checking a change before claiming it's better. |

## Install
Copy a skill's folder into your project's `.claude/skills/` (Claude Code) or wherever your agent looks for skills, or
reference it from your `AGENTS.md`:

```bash
mkdir -p .claude/skills
curl -fsSL https://raw.githubusercontent.com/Samsung/qaboard/master/skills/qaboard-integration/SKILL.md \
  --create-dirs -o .claude/skills/qaboard-integration/SKILL.md
```

Or clone the repository and copy `skills/<name>/` with its `references/`. Then ask your agent: "Integrate this
project with QA-Board" or "Check whether my change improved the detector".

## Keep them true
The skills are part of the repository so they change with the code. When a user-visible behavior changes
(*qaboard.yaml* keys, `qa` options, the `Run` object), update the skill in the same PR, like the docs. CI checks that
the docs links they contain exist.
