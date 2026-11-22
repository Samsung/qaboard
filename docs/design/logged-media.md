# Logged media: the design

Status: November 2026, being built. Format: the docstring of `qaboard/media.py`. Code: `webapp/src/viewers/media/`,
`webapp/src/viewers/audio/`. Limits: `docs/warts.md` (Logged media).

The API looks like what people know (`run.log({"samples": [qb.Image(x)]}, step=step)`), on purpose: nobody should
relearn how to log. The product must not look like what they know. After years with run trackers, what goes wrong
with media panels is well known, and each item below answers one of these problems.

## What goes wrong in run trackers, and what we do instead

| What goes wrong | What we do |
|---|---|
| A media panel per key, each with its own step slider, set up by hand in a workspace. Ten keys means ten sliders out of sync | **One timeline per run card**: every key moves together. Nothing to set up: a run that logs media shows them |
| The slider is a bare number line: you don't know where the interesting steps are, so you scrub blind | **The timeline shows what happened**: a tick per logged step for each key, the run's main series (the loss, or one the user picks) drawn faintly behind it, and the reference run's steps. Hovering a tick previews the media at that step |
| Curves and media live in separate panels: you see a spike in the loss and then hunt for the step by hand | **Linked views**: the media's step is a cursor on the series plots, and clicking a series plot moves the media to that step. Selecting a step is selecting a moment of the run, everywhere on the card |
| You compare runs by opening two tabs, and samples match by their position in a batch, which breaks as soon as the loader shuffles | **New against the reference run, at the same step, by default.** Samples match by `id` (`qb.Image(x, id="img_0042")`), else by caption, else by position. When the reference has no media at that step, the nearest earlier one is shown and labeled: never silently |
| Seeing how one sample changes over training means scrolling through steps one by one | **Evolution strip**: one sample across every step it was logged at, as a filmstrip, new above reference. This is the view people want most and never get |
| Thumbnails are small, and clicking opens a bigger thumbnail | **Click opens QA-Board's image viewer**: zoom, pixel values, new against reference, the difference, regions. A media panel that is a real viewer is what a QA tool brings |
| Boxes: everything is drawn at once, unreadable on a crowded image | **Box controls**: show or hide groups (predictions, ground truth), a score threshold, a legend with one stable color per label, the count shown per image |
| Tables are rendered whole, slowly, and two runs' tables can't be compared | **A table viewer**: virtualized, sortable, filtered, numeric columns with a distribution in their header. **Diff against the reference's table**, rows joined by a key column, changed cells marked |
| Histograms are drawn as overlapping curves that nobody reads | **Distribution over steps** as a heatmap with median and 5–95% bands; the selected step's histogram below it, the reference's outlined |
| Audio is the browser's player | **The audio viewer**: waveform or spectrogram, the reference's above it on the same time axis, switch A/B while it plays, matched loudness for a fair comparison |
| Text samples (an LLM's answers) are listed, and comparing them means copy-paste | **Text diff** against the reference's at the same step, and against the previous step |
| You can't send someone "this sample at this step" | **Everything is in the URL**: the step, the key, the sample, the compare mode (`src/selection.js`). Copy the address and send it |
| An empty panel tells you nothing | **Empty states that teach**: a run started from code with no media shows the two lines to log some. A key not logged yet at this step says when it starts |
| A mouse is required | **Keyboard**: ←/→ moves between logged steps, ↑/↓ between samples, `space` switches new/reference, `e` opens the evolution strip, `f` opens full screen. `?` lists them |

## Discovery

- The section's header says what is there before you open anything: *12 keys · steps 0–24 000 · images,
  audio, tables*.
- **Contents**: the keys grouped by prefix (`val/…`), each with its kind, how many steps, the last one, and a
  thumbnail. Filtered as you type. **Pin** keys to keep them on top; pins and collapsed groups are remembered per
  project (user preferences, Zustand).
- Each key's header has its affordances: open in the evolution strip, compare across steps, open in full screen,
  download the file.

## Layout

The timeline sits above the media, sticky, so that it stays visible while you scroll the keys. Then one block per key:
the new run's items in a responsive grid, each with the reference's at the same step, as a pair (side by side, or
stacked on narrow cards); a caption, and a chip when the item shown is from another step than the one selected.

## Next (not in the first version)
- **The runs of a batch at one step**, in the Summary view: a grid of runs × keys, like the comparison of their
  series. Once the runs page (`docs/rfcs/python-sdk-runs-follow-ups.md` A) exists, across batches too.
- **Find what changed most**: rank the samples by how far they are from the reference's (image difference, text
  edit distance, table cells), then open the worst first.
- Flag a sample and attach a note, shared with the team (with the gate's comments, `docs/rfcs/gate-scopes-and-comments.md`).
- Masks on images, with the same controls as boxes.
