import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { Editor, loader } from "@monaco-editor/react";
import { useIsDark } from "../theme";
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

// In the dark theme, editors have the background of the cards they are in (--qa-surface in App.css)
const dark_theme = "qa-dark";
monaco.editor.defineTheme(dark_theme, {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: { "editor.background": "#252a31" },
});

// Monaco's theme is global: all the editors follow the app's theme
const useMonacoTheme = () => {
  const dark = useIsDark();
  useEffect(() => monaco.editor.setTheme(dark ? dark_theme : "vs"), [dark]);
  return dark ? dark_theme : "light";
}

// Same props as react-monaco-editor, which we used to use
const MonacoEditorImpl = ({ editorDidMount, ...props }) => {
  const theme = useMonacoTheme();
  return <Editor onMount={editorDidMount} theme={theme} {...props}/>;
}

// We don't use @monaco-editor/react's DiffEditor, it updates the original text in place, and monaco then applies
// the diff it was computing to the new text ("startLineNumber X cannot be after endLineNumberExclusive Y").
// It also disposes the models before the editor ("TextModel got disposed before DiffEditorWidget model got reset").
// Replacing the models of a diff editor also races with its diff computation, so new texts get a new editor.
export const MonacoDiffEditorImpl = ({ original, value, language, options, width = "100%", height = "100%", editorDidMount }) => {
  useMonacoTheme();
  const container = useRef(null);
  const editor = useRef(null);

  useEffect(() => {
    const diffEditor = monaco.editor.createDiffEditor(container.current, { automaticLayout: true, ...options });
    diffEditor.setModel({
      original: monaco.editor.createModel(original ?? "", language),
      modified: monaco.editor.createModel(value ?? "", language),
    });
    editor.current = diffEditor;
    editorDidMount?.(diffEditor, monaco);
    return () => {
      // in this order, otherwise monaco reports errors
      const models = diffEditor.getModel();
      diffEditor.setModel(null);
      models.original.dispose();
      models.modified.dispose();
      diffEditor.dispose();
    };
  }, [original, value, language]); // eslint-disable-line react-hooks/exhaustive-deps -- options are updated below

  useEffect(() => { editor.current.updateOptions(options) }, [options]);

  return <div ref={container} style={{ width, height }}/>;
};

export default MonacoEditorImpl;
