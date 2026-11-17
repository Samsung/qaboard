# Stand-ins
Pictures shown in the docs until a planned shot is captured from the demo stack: see "Stand-ins" in
[`../README.md`](../README.md). A shot's `standin:` key in `../shots.yaml` names its files here.

`make.py` makes the performance viewers' stand-ins (`commit/benchmarks`, `commit/flame-top-functions`): run it again
when their viewer changes, then update the sizes and the numbers of `alt` and `caption` in `../shots.yaml`.

When a shot is published, delete its files and its `standin:` key in the same pull request. Keep this folder, even
empty: the docs image copies it (`website/Dockerfile`).
