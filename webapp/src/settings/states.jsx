// Loading and error states of the settings and admin pages
import { Button, Callout, Intent, Spinner } from "@blueprintjs/core";

import { errorMessage, errorTitle, isRetryable } from "../api/http";


// No Retry for 4xx answers: retrying a 403 or 404 doesn't help
export const QueryError = ({ error, refetch, what }) => <Callout intent={Intent.DANGER} title={errorTitle(error, what)}>
  <p>{errorMessage(error)}</p>
  {refetch && isRetryable(error) && <Button icon="refresh" text="Retry" onClick={() => refetch()}/>}
</Callout>;

export const Loading = ({ label }) => <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }} aria-busy="true">
  <Spinner size={24} aria-label={label}/>
</div>;
