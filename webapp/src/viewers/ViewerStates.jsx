import { Callout, Intent, Spinner } from "@blueprintjs/core";

import { errorMessage } from "../api/http";


// While a viewer's code or files load. It takes about the viewer's space, so the card doesn't jump when it arrives.
export const ViewerLoading = ({ height }) => <div
  aria-busy="true"
  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: height || '100px' }}
>
  <Spinner size={20} aria-label="Loading"/>
</div>


// When a viewer can't get its file, e.g. "404 NOT FOUND"
export const ViewerError = ({ path, error }) => <Callout compact intent={Intent.DANGER} icon="error" style={{ margin: '5px 0' }}>
  Could not load <code>{path}</code>: {errorMessage(error)}
</Callout>
