import * as monaco from "monaco-editor";
import { Editor, DiffEditor, loader } from "@monaco-editor/react";
// Vite resolves `?worker` imports to worker constructors
// oxlint-disable-next-line import/default
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
// oxlint-disable-next-line import/default
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
// oxlint-disable-next-line import/default
import CssWorker from "monaco-editor/language/css/css.worker?worker";
// oxlint-disable-next-line import/default
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
// oxlint-disable-next-line import/default
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

// Web workers for the editor and language services, bundled by Vite. Each is only downloaded when needed.
const workers = {
  json: JsonWorker,
  css: CssWorker, scss: CssWorker, less: CssWorker,
  html: HtmlWorker, handlebars: HtmlWorker, razor: HtmlWorker,
  typescript: TsWorker, javascript: TsWorker,
};
self.MonacoEnvironment = {
  getWorker: (_, label) => new (workers[label] ?? EditorWorker)(),
};

// Use the bundled monaco instead of downloading it from a CDN
loader.config({ monaco });

// Same props as react-monaco-editor, which we used to use
const MonacoEditorImpl = ({ editorDidMount, ...props }) => <Editor onMount={editorDidMount} {...props}/>;

export const MonacoDiffEditorImpl = ({ editorDidMount, value, ...props }) => <DiffEditor onMount={editorDidMount} modified={value} {...props}/>;

export default MonacoEditorImpl;
