// Saving the rules in the URL (src/matching/rules.js), with a toast to undo: a rule changes the references of many runs
import { Intent } from "@blueprintjs/core";

import { updateSelected } from "../selection";
import { toaster } from "../toaster";
import { rules_defaults, rules_to_selection } from "./rules";

const save = rules => updateSelected(rules_to_selection(rules), { defaults: rules_defaults });

// `message`: what changed, shown with Undo. Without, nothing is shown.
export const save_rules = (previous, next, message) => {
  save(next);
  if (message) toaster.show({
    message,
    icon: 'link',
    intent: Intent.NONE,
    timeout: 8000,
    action: { text: 'Undo', onClick: () => save(previous) },
  }, 'reference-rules');
};
