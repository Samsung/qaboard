# project: serving-latency
# user: kaito
# env: CI=true GITHUB_SHA=702abb3bcc4684e2809bd3cd38d5df39cd7e8441 GITHUB_REF=refs/heads/agent/result-cache
# alt: A terminal in CI runs qa gate on the coding agent's shared cache against its parent: in the rules table, p99 is thousands of percent worse where 10% is allowed, and the gate fails with exit code 1. On the sharded cache, p99 is better than the parent's, every rule passes and it exits with 0.
# caption: qa gate compares a commit's CI batch with a reference, rule by rule, and fails the job when one breaks.
# poster: 9000
# dedupe_tolerance: 0.001
#
# cli/gate (docs-media/shots.yaml). Recorded by: uv run docs-media/tapes/record.py --only cli/gate
# As the CI of the agent/result-cache branch (env): the shared cache (examples/serving-latency/story.yaml: cache-shared)
# against its parent, batch-overflow-fix, then of perf/sharded-cache (cache-sharded) against the same commit. The shas:
# <results>/.qaboard-demo/demo.json. The gate's rules are in the example's qaboard.yaml; it reads the stack's results,
# nothing is measured here.
# The dedupe tolerance: VHS types in real time, a character can show a frame later (0.06% of a frame).
Source "tapes/_settings.tape"
Output out/cli/gate/tape.mp4
Output out/cli/gate/tape.webm

Hide
Type "cd ~/kitefin/inference-gateway && export PARENT=fe9bbfabe9c1cf053090e1fa91e8775a59b3be4e && clear"
Enter
Show

Sleep 800ms
Type "# the coding agent's shared result cache, against the commit it started from"
Enter
Type "qa gate --reference $PARENT"
Sleep 700ms
Enter
Hide
Wait@60s /\$$/
Show
Sleep 1s
Type "echo $?"
Enter
Sleep 4s

Hide
Type "export GITHUB_SHA=b6b986c7c0edc966a189eb1526e3bf86b407616e GITHUB_REF=refs/heads/perf/sharded-cache && clear"
Enter
Show
Sleep 600ms
Type "# the sharded cache"
Enter
Type "qa gate --reference $PARENT"
Sleep 700ms
Enter
Hide
Wait@60s /\$$/
Show
Sleep 1s
Type "echo $?"
Enter
Sleep 4s
