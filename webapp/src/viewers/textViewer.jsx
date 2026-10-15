import GenericTextViewer from "./text";


const TextViewer = ({ output_new, output_ref, path, ...props }) => <GenericTextViewer
  text_url_new={output_new?.output_dir_url ? `${output_new.output_dir_url}/${path}` : null}
  text_url_ref={output_ref?.output_dir_url ? `${output_ref.output_dir_url}/${path}` : null}
  filename={path}
  is_running={output_new?.is_running || output_ref?.is_running}
  {...props}
/>


export default TextViewer;
