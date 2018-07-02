import React, { Component } from "react";

import { SlamOutputCard } from "./slam/SlamOutputCard";
import { TofOutputCard } from "./tof/TofOutputCard";
import { CisOutputCard } from "./cis/CisOutputCard";

class OutputCard extends Component {
  render() {
    const { output_new, output_ref, warning, layout, ...props } = this.props;
    if (output_new.output_type === "slam/6dof")
      return (
        <SlamOutputCard
          output_new={output_new}
          output_ref={output_ref}
          warning={warning}
          layout={layout}
          {...props}
        />
      );
    else if (output_new.output_type === "cis/image")
      return (
        <CisOutputCard
          output_new={output_new}
          output_ref={output_ref}
          warning={warning}
          layout={layout}
          {...props}
        />
      );
    else if (output_new.output_type === "tof/depth")
      return (
        <TofOutputCard
          output_new={output_new}
          output_ref={output_ref}
          warning={warning}
          layout={layout}
          {...props}
        />
      );
    else return <span>Unsupport output type</span>;
  }
}

export { OutputCard };
