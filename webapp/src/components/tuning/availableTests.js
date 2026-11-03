// Links to "Available Tests", the view that edits QA-Board's own batch files: e.g. "this batch is defined in the shared batches"
import { create } from "zustand";

import { updateSelected } from "../../selection";


// The batch file everyone in the project can edit, as {name}.yml. Users each have a private one, named after them.
export const SHARED_BATCHES_FILE = "extra-batches";

// Asks "Available Tests" to show one of its files, at a batch: {file: its name, without .yml, batch?, id}.
// The view clears the request once it showed it.
export const useAvailableTestsRequest = create(() => ({ request: null }));

let last_id = 0;

/**
 * Shows a file of "Available Tests", at a batch.
 * `navigate: false` when the view is already shown, e.g. from its own drawer: it keeps the other views.
 */
export const openInAvailableTests = ({ file, batch, navigate = true }) => {
  useAvailableTestsRequest.setState({ request: { file, batch, id: ++last_id } });
  if (navigate)
    updateSelected({ selected_views: "groups" });
};

export const clearAvailableTestsRequest = id => useAvailableTestsRequest.setState(state => state.request?.id === id ? { request: null } : state);
