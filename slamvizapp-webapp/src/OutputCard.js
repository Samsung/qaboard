import React, { Component } from "react";
import Loadable from 'react-loadable';

// import { SlamOutputCard } from "./slam/SlamOutputCard";
// import { TofOutputCard } from "./tof/TofOutputCard";
// import { CisOutputCard } from "./cis/CisOutputCard";


const Loading = props => {
  if (props.error) {
    return <div>Error!</div>;
  } else {
    return <div></div>;
  }
};


const LoadableSlamOutputCard = Loadable({
  loader: () => import('./slam/SlamOutputCard' /* webpackChunkName: "slam" */),
  loading: Loading,
});
const LoadableTofOutputCard = Loadable({
  loader: () => import('./tof/TofOutputCard' /* webpackChunkName: "tof" */),
  loading: Loading,
});
const LoadableCisOutputCard = Loadable({
  loader: () => import('./cis/CisOutputCard' /* webpackChunkName: "cis" */),
  loading: Loading,
});


class OutputCard extends Component {
  render() {
    const { output_new, output_ref, warning, layout, ...props } = this.props;
    if (output_new.output_type === "slam/6dof")
      return (
        <LoadableSlamOutputCard
          output_new={output_new}
          output_ref={output_ref}
          warning={warning}
          layout={layout}
          {...props}
        />
      );
    else if (output_new.output_type === "cis/image")
      return (
        <LoadableCisOutputCard
          output_new={output_new}
          output_ref={output_ref}
          warning={warning}
          layout={layout}
          {...props}
        />
      );
    else if (output_new.output_type === "tof/depth")
      return (
        <LoadableTofOutputCard
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
