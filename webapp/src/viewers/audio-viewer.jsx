// The audio viewer in QA-Board: the run's file and the reference run's, for the standalone viewer, audio/AudioViewer.jsx,
// with the names and colors of what the page compares. It downloads and decodes the files itself.
import { useLabels } from "../hooks";
import { AudioViewer } from "./audio/AudioViewer";

const fileUrl = (output, path) => `${output.output_dir_url}/${path.split('/').map(encodeURIComponent).join('/')}`;

// - caption, caption_ref: e.g. the samples' captions in logged media
// - height: of each track, in pixels
// - compact: a row with play and A/B, for grids of sounds, that expands in place, or calls onExpand
const AudioFileViewer = ({ output_new, output_ref, path, path_ref, labels, height, caption, caption_ref, compact, onExpand }) => {
  const resolved_labels = useLabels(labels);
  const src = output_new?.output_dir_url && path ? fileUrl(output_new, path) : undefined;
  // without the reference's file, we show the new one alone
  const src_ref = src && output_ref?.output_dir_url && !output_ref.deleted && output_ref.id !== output_new.id ? fileUrl(output_ref, path_ref ?? path) : undefined;
  if (!src) return null;
  return <AudioViewer
    src={src} src_ref={src_ref} labels={resolved_labels} caption={caption} caption_ref={caption_ref}
    height={height ? parseInt(height, 10) || undefined : undefined} compact={compact} onExpand={onExpand}
  />;
};

export default AudioFileViewer;
