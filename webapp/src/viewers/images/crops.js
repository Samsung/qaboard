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


import { iiif_url } from "./utils";

const toaster = Toaster.create();


const uniq_rois = array => {
  let seen = {};
  return array.filter(function(item) {
      const key = `${item.x} ${item.y} ${item.w} ${item.h} ${item.label} ${item.focused}`
      return seen.hasOwnProperty(key) ? false : (seen[key] = true);
  });
}


const output_rois = output => {
  let configs_rois = output.configurations.filter(c => typeof c === 'object' && !!c.roi).map(c => c.roi).flat()
  let input_rois = output.test_input_metadata?.roi ?? [];
  let rois = [...input_rois, ...configs_rois];
  rois = uniq_rois(rois) // remove duplicates

  const { width: image_width, height: image_height } = output.test_input_metadata || {};
  if (image_width !== undefined || image_height !== undefined)
    rois = rois.map(roi => {
      return {image_width, image_height, ...roi}
    })
  if (rois.length>0) {
    rois.push({label: 'Full image'})
  }
  return rois;
}


class Crops extends React.Component {
  componentDidMount() {
    const { output_new, viewer } = this.props;
    if (!!!output_new || !!!viewer) return;

    let rois = output_rois(output_new)

    if (rois.length>0) {
      let focused_rois = rois.filter(r => r.focused)
      const focused_roi = focused_rois.length > 0 ? focused_rois[focused_rois.length-1] : rois[0]
      fitTo(focused_roi, viewer)  
    }
  }
  render() {
    const { output_new, viewer } = this.props;
    if (!!!output_new || !!!viewer) return <span />

    // TODO: add an ROI "full"
    // TODO: read from 
    let regions_of_interest = output_rois(output_new)
    if (!!!regions_of_interest) return <span />

    const tags = regions_of_interest.map((roi, idx) => {
      let height = 50;
      let url_prefix = iiif_url(output_new.output_dir_url, this.props.path)
      const x = roi.x * viewer.source.width  / (roi.image_width  ?? viewer.source.width)
      const y = roi.y * viewer.source.height / (roi.image_height ?? viewer.source.height)
      const w = roi.w * viewer.source.width  / (roi.image_height ?? viewer.source.width)
      const h = roi.h * viewer.source.height / (roi.image_width  ?? viewer.source.height)
      let src = roi.label !== 'Full image' ? `${url_prefix}/${x},${y},${w},${h}/,${height}/0/default.jpg`: `${url_prefix}/full/,${height}/0/default.jpg`
      let tooltip_text = <p align="center">
        <span>{roi.label || roi.tag || idx}</span>
        <span>Select next/before roi with keyboard shortcut n/b</span>
      </p>

      const is_valid = isValidRoi(roi, viewer) || roi.label === 'Full image';
      let is_selected = false; // viewer.coordinates === roi.coordinates
      /*
      // it would be nice, but openseadragon doensn't trigger a react re-render,
      // so it's broken.
      if (is_valid) {
        console.log(roi.label)
        let viewport_center =  viewer.viewport.getCenter()
        let image_center = viewer.viewport.viewportToImageCoordinates(viewport_center)
        console.log("image_center", image_center)
        let roi_center = {x: roi.x+roi.w/2, y: roi.y+roi.h/2}
        console.log("roi_center", roi_center, {x: roi.x, y: roi.y})
        is_selected = true
      }
      */
    


      return <Tooltip
        key={idx}
        intent={is_valid ? undefined : Intent.DANGER}
        content={is_valid ? tooltip_text : `Invalid coordinates! ${JSON.stringify(roi)}`}
      >
        <AnchorButton
          onClick={() => { fitTo(roi, viewer) }}
          intent={is_selected ? Intent.PRIMARY : null}
          disabled={!is_valid}
          large={false}
          minimal
          style={{ margin: "5px" }}
        >
          <div><img src={src} alt={idx} height={height} /></div>
          <div><span>{roi.label || roi.tag || idx}</span></div>
        </AnchorButton>
      </Tooltip>
    });

    return <div>{tags}</div>;
  }

}
const fitTo = (roi, viewer, retry_on_viewer_update=true) => {
  if (roi.label === "Full image") {
    viewer.viewport.goHome()
    return
  }
  if (!isValidRoi(roi, viewer)) {
    if (retry_on_viewer_update){
      viewer.addOnceHandler('tile-drawn', () => fitTo(roi, viewer, false));
    } else {
      return;
    }
  }

  let { x, y, width, height } = viewer.viewport.imageToViewportRectangle(
    roi.x * viewer.source.width  / (roi.image_width ?? viewer.source.width),
    roi.y * viewer.source.height / (roi.image_height ?? viewer.source.height),
    roi.w * viewer.source.width  / (roi.image_height ?? viewer.source.width),
    roi.h * viewer.source.height / (roi.image_width ?? viewer.source.height),
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
  if (roi.label === "Full image")
    return true;
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


const CropSelection = ({ roiCoords, image_width, image_height }) => {
  if (roiCoords) {
    const { x, y, width, height } = roiCoords
    // const image_coords = viewer.viewport.viewportToImageRectangle(selection.rect);
    const to_clipboard =
      `width: ${image_width}\nheight: ${image_height}\n- {x: ${Math.round(x)}, y: ${Math.round(y)}, w: ${Math.round(width)}, h: ${Math.round(height)}, label: ""}`;
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

export { Crops, fitTo, isValidRoi, CropSelection, output_rois };
