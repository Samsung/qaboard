import React from "react";
import copy from 'copy-to-clipboard';

import {
  AnchorButton,
  Button,
  Intent,
  Icon,
  Tooltip,
  Toaster,
} from "@blueprintjs/core";

import { deserialize_config } from './../../utils';


const toaster = Toaster.create();


class Crops extends React.PureComponent {
  render() {
    const { output_new, viewer } = this.props;
    if (!!!output_new || !!!viewer) return <span />

    let configs_with_regions_of_interest =
      deserialize_config(output_new.configuration).filter(c => typeof c === 'object' && !!c.roi)
    let { roi: regions_of_interest } = configs_with_regions_of_interest.length ?
      configs_with_regions_of_interest[0] : {}

    if (!!!regions_of_interest) return <span />

    const tags = regions_of_interest.map((roi, idx) => {

      const is_valid = isValidRoi(roi, viewer);
      let is_selected = true; // viewer.coordinates === roi.coordinates
      return <Tooltip
        key={idx}
        disabled={is_valid && !!!roi.tooltip}
        intent={Intent.DANGER}
        content={`Invalid coordinates! ${JSON.stringify(roi)}`}
      >
        <AnchorButton
          onClick={() => { fitTo(roi, viewer) }}
          intent={is_selected ? Intent.PRIMARY : null}
          disabled={!is_valid}
          large={false}
          style={{ margin: "5px" }}
        >
          {roi.label || roi.tag || idx}
        </AnchorButton>
      </Tooltip>
    });

    return <div>{tags}</div>;
  }

}
const fitTo = (roi, viewer) => {
  if (!isValidRoi(roi, viewer))
    return;

  let { x, y, width, height } = viewer.viewport.imageToViewportRectangle(
    roi.x,
    roi.y,
    roi.w,
    roi.h,
  );
  const center = {
    x: x + width / 2,
    y: y + height / 2,
  };

  // best fit algorithm
  let { x: image_width, y: image_height } = viewer.world.getItemAt(0).getContentSize();
  const zoom = (Math.abs(roi.w) > Math.abs(roi.h)) ? image_width / Math.abs(roi.w) : image_height / Math.abs(roi.h);

  viewer.viewport.zoomTo(zoom);
  viewer.viewport.panTo(center);
};


const isValidRoi = (roi, viewer) => {
  if (isNaN(roi.x + roi.y + roi.w + roi.h)) return false;

  let viewport_rec = viewer.viewport.imageToViewportRectangle(
    roi.x,
    roi.y,
    roi.w,
    roi.h,
  );

  if (!(0 <= viewport_rec.x && viewport_rec.x <= 1) ||
    !(0 <= viewport_rec.y && viewport_rec.y <= 1) ||
    !(-1 <= viewport_rec.width && viewport_rec.width <= 1) ||
    !(-1 <= viewport_rec.height && viewport_rec.height <= 1)) {
    return false;
  }
  return true;
};


const CropSelection = ({ imageCoords }) => {
  if (imageCoords) {
    // const image_coords = viewer.viewport.viewportToImageRectangle(selection.rect);
    const to_clipboard =
      `- {` +
      `x: ${Math.round(imageCoords.x)}, ` +
      `y: ${Math.round(imageCoords.y)}, ` +
      `w: ${Math.round(imageCoords.width)}, ` +
      `h: ${Math.round(imageCoords.height)}, ` +
      `label: ""}`;
    return (
      <Tooltip hoverCloseDelay={1000}>
        <Button
          minimal="true"
          style={{ marginRight: '5px', marginLeft: '5px' }}
          onClick={() => {
            copy(to_clipboard)
            toaster.show({ message: "Copied!", intent: Intent.SUCCESS, timeout: 3000 });
          }}
        >
          <Icon
            icon="clipboard"
            intent={Intent.PRIMARY}
            iconSize={Icon.SIZE_LARGE}
          />
        </Button>
        <span>{to_clipboard}</span>
      </Tooltip>
    )
  }
}

export { Crops, fitTo, isValidRoi, CropSelection };
