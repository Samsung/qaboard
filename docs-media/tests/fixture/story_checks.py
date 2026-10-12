"""Custom checks for the fixture's story (see examples/STORY.md#checks)."""
import hashlib


def same_outputs(ctx, vs):
  """The commit's CI runs write the same out.png as those of `vs`."""
  digest = lambda run: hashlib.sha256(run.file('out.png').read_bytes()).hexdigest()
  new = {run.key: digest(run) for run in ctx.runs(ctx.commit) if not run.failed}
  ref = {run.key: digest(run) for run in ctx.runs(vs) if not run.failed}
  if not new or set(new) != set(ref):
    return False, f"different runs: {sorted(new)} vs {sorted(ref)}"
  differ = [key for key in new if new[key] != ref[key]]
  # the real CLI agrees
  process = ctx.qa('check-bit-accuracy', '--batch', 'ci', '--reference', ctx.sha(vs), commit=ctx.commit)
  return not differ and process.returncode == 0, f"{len(differ)}/{len(new)} runs differ, check-bit-accuracy exited with {process.returncode}"
