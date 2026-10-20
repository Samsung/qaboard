// Loading and error states of the settings and admin pages
import { Button, Callout, Intent, Spinner } from "@blueprintjs/core";

import { errorMessage } from "../api/http";


export const QueryError = ({ error, refetch, what }) => <Callout intent={Intent.DANGER} title={`Could not load ${what}`}>
  <p>{errorMessage(error)}</p>
  {refetch && <Button icon="refresh" text="Retry" onClick={() => refetch()}/>}
</Callout>;

export const Loading = ({ label }) => <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }} aria-busy="true">
  <Spinner size={24} aria-label={label}/>
</div>;
