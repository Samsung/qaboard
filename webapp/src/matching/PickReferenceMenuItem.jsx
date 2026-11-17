// In the run's menu: opens the reference picker on the run's card (ReferenceMatchTag), when the run can have one
import { MenuItem } from "@blueprintjs/core";

import { useComparison } from "../hooks";
import { useReferencePicker } from "./pickerStore";
import { can_have_reference } from "./match";

export const PickReferenceMenuItem = ({ output }) => {
  const comparison = useComparison();
  const open = useReferencePicker(state => state.open);
  if (!comparison?.ref_lookup?.outputs?.length || !can_have_reference(output)) return null;
  return <MenuItem
    icon="changes"
    text="Change reference run…"
    htmlTitle="Pick the reference run this run is compared with, or a rule for all the runs"
    onClick={() => open(output.id)}
  />;
};
