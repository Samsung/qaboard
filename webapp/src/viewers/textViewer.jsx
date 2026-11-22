import GenericTextViewer from "./text";


// path_ref: the reference's file, when it isn't at the same path (e.g. logged media at another step)
const TextViewer = ({ output_new, output_ref, path, path_ref, ...props }) => <GenericTextViewer
  text_url_new={output_new?.output_dir_url ? `${output_new.output_dir_url}/${path}` : null}
  text_url_ref={output_ref?.output_dir_url ? `${output_ref.output_dir_url}/${path_ref ?? path}` : null}
  filename={path}
  filename_ref={path_ref}
  is_running={output_new?.is_running || output_ref?.is_running}
  {...props}
/>


export default TextViewer;
