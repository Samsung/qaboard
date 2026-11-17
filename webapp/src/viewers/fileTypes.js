// Files that viewers open by their name, without a `type` in qaboard.yaml. Apart from the viewers (OutputViewer.jsx)
// so that code that only needs the names doesn't load them: run cards show these files for runs created from code
// (runView.js). `qa upload` reads metrics from the same names: is_junit in qaboard/junit.py, is_benchmarks in
// qaboard/benchmarks.py. Change one, change the other.

// Profiles the flame graph viewer reads (flamegraph/formats.js): QA-Board's *flame.json, folded stacks, speedscope,
// Chrome's .cpuprofile, gzipped or not. Other names need `type: flame`
export const is_flame_graph = path => /(flame\.json|\.folded|\.collapsed|\.stacks\.txt|\.speedscope\.json|\.cpuprofile)(\.gz)?$/i.test(path || '');

// JUnit XML test reports: junit.xml, report.junit.xml, Maven's and Gradle's TEST-*.xml
export const is_junit = path => /(^|\/)(junit|[^/]*[._-]junit|TEST-[^/]*)\.xml$/i.test(path || '');

// Benchmark files: benchmarks.json, pytest.benchmarks.json, codec-bench.jsonl... Not a bare bench.json: projects had
// files with that name before the viewer. Other names need `type: benchmarks`. Files picked by their name that aren't
// benchmark files are shown as text, as before.
export const is_benchmarks = path => /(^|\/)(([^/]*[._-])?benchmarks?|[^/]*[._-]bench)\.(json|jsonl|ndjson)$/i.test(path || '');
