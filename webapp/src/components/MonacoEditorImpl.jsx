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

// Monaco has no language for patches (.patch, .diff, the local changes of runs): the lines git adds, removes, and its headers
if (!monaco.languages.getLanguages().some(language => language.id === "diff")) {
  monaco.languages.register({ id: "diff", extensions: [".diff", ".patch"] });
  monaco.languages.setMonarchTokensProvider("diff", {
    tokenizer: {
      root: [
        [/^(diff --git|index|new file mode|deleted file mode|old mode|new mode|similarity index|rename from|rename to|Binary files).*$/, "header.diff"],
        [/^(\+\+\+|---) .*$/, "header.diff"],
        [/^@@.*$/, "meta.diff"],
        [/^\+.*$/, "inserted.diff"],
        [/^-.*$/, "deleted.diff"],
        [/^\\ No newline.*$/, "comment.diff"],
        [/^(From|Date|Subject|Author|commit) .*$/, "comment.diff"],
      ],
    },
  });
}
const diff_rules = dark => [
  { token: "header.diff", foreground: dark ? "abb3bf" : "5f6b7c", fontStyle: "bold" },
  { token: "meta.diff", foreground: dark ? "8abbff" : "2d72d2" },
  { token: "inserted.diff", foreground: dark ? "72ca9b" : "1c6e42" },
  { token: "deleted.diff", foreground: dark ? "fa999c" : "ac2f33" },
  { token: "comment.diff", foreground: dark ? "8f99a8" : "738091", fontStyle: "italic" },
];

// In the dark theme, editors have the background of the cards they are in (--qa-surface in App.css)
const dark_theme = "qa-dark";
monaco.editor.defineTheme(dark_theme, {
  base: "vs-dark",
  inherit: true,
  rules: diff_rules(true),
  colors: { "editor.background": "#252a31" },
});
const light_theme = "qa-light";
monaco.editor.defineTheme(light_theme, {
  base: "vs",
  inherit: true,
  rules: diff_rules(false),
  colors: {},
});

// Monaco's theme is global: all the editors follow the app's theme
const useMonacoTheme = () => {
  const dark = useIsDark();
  useEffect(() => monaco.editor.setTheme(dark ? dark_theme : light_theme), [dark]);
  return dark ? dark_theme : light_theme;
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
