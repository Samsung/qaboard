// Monaco is ~1MB gzipped: it is only downloaded when an editor is rendered.
import { lazy, Suspense } from "react";

const Editor = lazy(() => import("./MonacoEditorImpl"));
const DiffEditor = lazy(() => import("./MonacoEditorImpl").then(m => ({ default: m.MonacoDiffEditorImpl })));

const placeholder = ({width, height}) => <div style={{width, height}}/>

const MonacoEditor = props => <Suspense fallback={placeholder(props)}>
  <Editor {...props}/>
</Suspense>

export const MonacoDiffEditor = props => <Suspense fallback={placeholder(props)}>
  <DiffEditor {...props}/>
</Suspense>

export default MonacoEditor;
