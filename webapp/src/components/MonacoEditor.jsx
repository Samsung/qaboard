// Monaco is ~1MB gzipped: it is only downloaded when an editor is (about to be) rendered.
import { lazy, Suspense } from "react";
import { Button, Callout, Classes, Intent, TextArea } from "@blueprintjs/core";

import { ErrorBoundary } from "./ErrorBoundary";
import { InlineErrorFallback } from "./ErrorFallback";

// Viewers call it as soon as they show, so that Monaco loads while they fetch their files
export const preloadMonaco = () => import("./MonacoEditorImpl");

const Editor = lazy(preloadMonaco);
const DiffEditor = lazy(() => preloadMonaco().then(m => ({ default: m.MonacoDiffEditorImpl })));

const placeholder = ({width, height}) => <div style={{width, height}}/>

// When Monaco crashes, e.g. on text people pasted, they keep editing the same text, as plain text: nothing is lost
const PlainTextEditor = ({ value, onChange, options, width = '100%', height = 300, retry, retries }) => <div style={{ width }}>
  <Callout compact intent={Intent.WARNING} icon="warning-sign" style={{ marginBottom: 6 }}>
    The code editor crashed: you can keep editing as plain text. The QA-Board maintainers can see the error.{' '}
    {retries === 0 && <Button size="small" variant="minimal" icon="refresh" text="Try the editor again" onClick={retry}/>}
  </Callout>
  <TextArea
    fill
    aria-label="Plain text editor"
    className={Classes.MONOSPACE_TEXT}
    style={{ height, fontSize: 12, resize: 'vertical' }}
    value={value ?? ''}
    readOnly={!onChange || !!options?.readOnly}
    spellCheck={false}
    onChange={event => onChange?.(event.target.value)}
  />
</div>;

const MonacoEditor = props => <ErrorBoundary name="editor" fallback={fallback => <PlainTextEditor {...props} {...fallback}/>}>
  <Suspense fallback={placeholder(props)}>
    <Editor {...props}/>
  </Suspense>
</ErrorBoundary>

export const MonacoDiffEditor = props => <ErrorBoundary
  name="diff-editor"
  resetKeys={[props.original, props.value]}
  fallback={fallback => <InlineErrorFallback {...fallback} title="Could not show the changes" description="The diff crashed."/>}
>
  <Suspense fallback={placeholder(props)}>
    <DiffEditor {...props}/>
  </Suspense>
</ErrorBoundary>

export default MonacoEditor;
