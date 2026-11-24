// The audio viewer in QA-Board: the run's file and the reference run's, for the standalone viewer, audio/AudioViewer.jsx,
// with the names and colors of what the page compares. It downloads and decodes the files itself.
import { useLabels } from "../hooks";
import { AudioViewer } from "./audio/AudioViewer";
import { run_file_url } from "./media/context";

// what identifies a file's contents, from its run's manifest: decoded tracks are cached by it
const version_of = entry => entry ? entry.md5_data ?? entry.md5 ?? (entry.st_size !== undefined ? `${entry.st_size}:${entry.st_mtime ?? ''}` : undefined) : undefined;

// - caption, caption_ref: e.g. the samples' captions in logged media
// - height: of each track, in pixels
// - compact: a row with play and A/B, for grids of sounds, that expands in place, or calls onExpand
const AudioFileViewer = ({ output_new, output_ref, path, path_ref, labels, height, caption, caption_ref, compact, onExpand, manifests }) => {
  const resolved_labels = useLabels(labels);
  const src = run_file_url(output_new, path);
  // without the reference's file, we show the new one alone
  const has_ref = !!src && !!output_ref && !output_ref.deleted && output_ref.id !== output_new.id;
  const src_ref = has_ref ? run_file_url(output_ref, path_ref ?? path) : undefined;
  if (!src) return null;
  return <AudioViewer
    src={src} src_ref={src_ref} labels={resolved_labels} caption={caption} caption_ref={caption_ref}
    height={height ? parseInt(height, 10) || undefined : undefined} compact={compact} onExpand={onExpand}
    version={version_of(manifests?.new?.[path])} version_ref={has_ref ? version_of(manifests?.reference?.[path_ref ?? path]) : undefined}
    live={!!output_new?.is_running || !!(has_ref && output_ref.is_running)}
  />;
};

export default AudioFileViewer;
