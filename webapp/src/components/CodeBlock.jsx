// A snippet to read or copy, highlighted: <CodeBlock language="python" code={...}/>. Its text is `code`, unchanged.
// Languages: python, yaml, shell (utils/highlight.js); colors: --qa-code-* in App.css, for both themes.
import { Classes } from "@blueprintjs/core";

import { highlight } from "../utils/highlight";


export const HighlightedCode = ({ code, language }) => highlight(code, language).map(({ type, text }, i) => type
  ? <span key={i} className={`qa-code-${type}`}>{text}</span>
  : text);

export const CodeBlock = ({ code, language, className, ...props }) => <pre className={className ? `${Classes.CODE_BLOCK} ${className}` : Classes.CODE_BLOCK} {...props}>
  <HighlightedCode code={code} language={language}/>
</pre>;

export default CodeBlock;
