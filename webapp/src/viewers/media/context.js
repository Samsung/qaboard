// Where the logged media's files are, and what shows them: the runs' folders and the app's viewers (OutputViewer).
// The playground (playground.jsx) gives its generated files and simple viewers instead.
import { createContext, useContext } from 'react';

// The URL of a file of a run, its path's segments encoded (names can have spaces, #, ?...)
export const run_file_url = (output, path) => output?.output_dir_url && path
  ? `${output.output_dir_url}/${path.split('/').map(encodeURIComponent).join('/')}`
  : undefined;

// { fileUrl(output, path), Viewer: a component with OutputViewer's props, or null for OutputViewer }
export const MediaContext = createContext({ fileUrl: run_file_url, Viewer: null });
export const useMediaContext = () => useContext(MediaContext);
