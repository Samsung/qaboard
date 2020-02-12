import React from "react";
import { MenuItem } from "@blueprintjs/core";

const noMetrics = <MenuItem disabled={true} text="No matching metrics." />;

// const renderMetric = (metric, {handleClick, modifiers, query} ) => {
//   if (!modifiers.matchesPredicate) {
//     return null;
//   }
//   return (
//     <MenuItem
//       active={modifiers.active}
//       icon={this.isMetricSelected(metric) ? "tick" : "blank"}
//       key={metric.key}
//       label={metric.key}
//       text={`${metric.label} [${metric.suffix}]`}
//       onClick={handleClick}
//       shouldDismissPopover={false}
//     />
//   );
// };

export { noMetrics };
