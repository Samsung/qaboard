# project: image-quality
# user: tobias
# env: CI=true GITHUB_SHA=a155692ff9ddf8c2f0580965b26648942dc8b4fe GITHUB_REF=refs/heads/fxp/round-half-even PYTHONHASHSEED=0
# alt: A terminal in CI runs qa check-bit-accuracy on the hw-model platform: on the rounding change, it fails and lists the files that differ from the release; on a commit that only changed docs, every file is the same.
# caption: qa check-bit-accuracy compares a commit's output files with the reference's, byte for byte.
# poster: 9000
# dedupe_tolerance: 0.001
#
# cli/bit-accuracy (docs-media/shots.yaml). Recorded by: uv run docs-media/tapes/record.py --only cli/bit-accuracy
# As the CI of the fxp/round-half-even branch (env), then of docs-tuning-guide: the commits of
# examples/image-quality/story.yaml, against the isp-4.1 release (the shas: <results>/.qaboard-demo/demo.json).
# PYTHONHASHSEED: qa lists the files that differ from a set, in the same order every time.
# The dedupe tolerance: VHS types in real time, a character can show a frame later (0.06% of a frame).
# Comments typed after the prompt narrate the tape; the commands run for real.
Source "tapes/_settings.tape"
Output out/cli/bit-accuracy/tape.mp4
Output out/cli/bit-accuracy/tape.webm

# The workspace is a git repository (record.py), as qa check-bit-accuracy needs, without the story's commits: the
# outputs it compares are the stack's, in <results>.
Hide
Type "cd ~/kitefin/camera-isp && export RELEASE=6e0be1abc1659bbdb80f773ecccb1e6c1a32259d && clear"
Enter
Show

Sleep 800ms
Type "# the fixed-point model's outputs, against the isp-4.1 release"
Enter
Type "qa --platform hw-model check-bit-accuracy --batch bitexact --reference $RELEASE"
Sleep 700ms
Enter
Hide
Wait@60s /\$$/
Show
Sleep 4s

Hide
Type "export GITHUB_SHA=5a6cef7c61a3fa64986f800833d5f6181cac78a1 GITHUB_REF=refs/heads/main && clear"
Enter
Show
Sleep 600ms
Type "# a commit that only changed the docs"
Enter
Type "qa --platform hw-model check-bit-accuracy --batch bitexact --reference $RELEASE"
Sleep 700ms
Enter
Hide
Wait@60s /\$$/
Show
Sleep 4s
