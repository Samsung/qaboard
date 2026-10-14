// Monaco is ~1MB gzipped: it is only downloaded when an editor is (about to be) rendered.
import { lazy, Suspense } from "react";

// Viewers call it as soon as they show, so that Monaco loads while they fetch their files
export const preloadMonaco = () => import("./MonacoEditorImpl");

const Editor = lazy(preloadMonaco);
const DiffEditor = lazy(() => preloadMonaco().then(m => ({ default: m.MonacoDiffEditorImpl })));

const placeholder = ({width, height}) => <div style={{width, height}}/>

const MonacoEditor = props => <Suspense fallback={placeholder(props)}>
  <Editor {...props}/>
</Suspense>

export const MonacoDiffEditor = props => <Suspense fallback={placeholder(props)}>
  <DiffEditor {...props}/>
</Suspense>

export default MonacoEditor;
