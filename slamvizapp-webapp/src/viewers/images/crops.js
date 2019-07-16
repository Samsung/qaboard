// TODO: documentation

import * as React from "react";
import { Button, H5, Intent, Switch, Tag } from "@blueprintjs/core";


class Crops extends React.PureComponent {
  state = {
    intent: Intent.PRIMARY,
    interactive: true,
    large: true,
    round: false,
    tags: this.props.regionsOfInterest,
    style: { margin: "5px" },
  };

  render() {

    const { tags, onClick, ...tagProps } = this.state;
    const tagElements = tags.map(crop => {
      return (
        <Tag
          onClick={() => { this.cropFunction(crop, this.props.viewer) }}
          {...tagProps}
        >
          {crop.tag}
        </Tag>
      );
    });
    return (
      <div >
        {tagElements}
      </div>
    );
  }

  // best fit algorithm
  cropFunction = (crop, viewer) => {

    let masterCenter;
    let masterZoom;

    let viewport_rec = viewer.viewport.imageToViewportRectangle(
      crop.x,
      crop.y,
      crop.w,
      crop.h);

    masterCenter = {
      x: (viewport_rec.x + viewport_rec.width / 2),
      y: (viewport_rec.y + viewport_rec.height / 2)
    };

    let orig_dimensions = viewer.world.getItemAt(0).getContentSize();

    let orig_zoom = () => {
      if (crop.w > crop.h) return (orig_dimensions.x / crop.w);
      else return (orig_dimensions.y / crop.h);
    }

    masterZoom = (orig_zoom());

    viewer.viewport.zoomTo(masterZoom);
    viewer.viewport.panTo(masterCenter);
  };

}

export default Crops;
