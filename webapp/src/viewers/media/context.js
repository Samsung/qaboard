// Where the logged media's files are, and what shows them: the runs' folders and the app's viewers (OutputViewer).
// The playground (playground.jsx) gives its generated files and simple viewers instead.
import { createContext, useContext } from 'react';

export const runFileUrl = (output, path) => output?.output_dir_url && path ? `${output.output_dir_url}/${path}` : undefined;

// { fileUrl(output, path), Viewer: a component with OutputViewer's props, or null for OutputViewer }
export const MediaContext = createContext({ fileUrl: runFileUrl, Viewer: null });
export const useMediaContext = () => useContext(MediaContext);
