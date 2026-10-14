import {
  AnchorButton,
  Button,
  Intent,
  Icon,
  Tooltip,
  IconSize,
} from "@blueprintjs/core";
import { copyWithToast } from "../../utils/clipboard"


import { iiif_url } from "./utils";



const uniq_rois = rois => {
  const seen = new Set();
  return rois.filter(roi => {
    if (seen.has(roi.key)) return false;
    seen.add(roi.key);
    return true;
  });
}


// The regions of interest from the output's input metadata and configurations. Returns new objects.
const output_rois = output => {
  const configs_rois = output.configurations.filter(c => typeof c === 'object' && !!c.roi).map(c => c.roi).flat()
  const input_rois = output.test_input_metadata?.roi ?? [];
  let rois = [...input_rois, ...configs_rois].map(roi => ({
    ...roi,
    key: `${roi.x} ${roi.y} ${roi.w} ${roi.h} ${roi.label}`,
  }));
  rois = uniq_rois(rois)

  const { width: image_width, height: image_height } = output.test_input_metadata ?? {};
  if (image_width !== undefined || image_height !== undefined)
    rois = rois.map(roi => {
      return {image_width, image_height, ...roi}
    })
  if (rois.length > 0) {
    rois.push({label: 'Full Image'})
  }
  return rois;
}


// ROIs can be given in the coordinates of an image of size roi.image_width x roi.image_height
// (the test input's metadata), which may not be the size of the image the viewer shows.
// Returns the ROI in the coordinates of the viewer's image (source is viewer.source).
const scale_roi = (roi, source) => {
  const scale_x = source?.width  ? source.width  / (roi.image_width  ?? source.width)  : 1
  const scale_y = source?.height ? source.height / (roi.image_height ?? source.height) : 1
  return {
    x: roi.x * scale_x,
    y: roi.y * scale_y,
    w: roi.w * scale_x,
    h: roi.h * scale_y,
  }
}


// manifest and imageServers: as for the image viewer, to request the same image (e.g. out.tiff instead of out.png)
// from the same image server
const Crop = ({roi, output, path, manifest, imageServers, viewer, selected, onSelect}) => {
  const url_prefix = iiif_url(output.output_dir_url, path, manifest, true, imageServers)
  const { x, y, w, h } = scale_roi(roi, viewer.source)
  const height = 50;
  const src = roi.label !== 'Full Image' ? `${url_prefix}/${x},${y},${w},${h}/,${height}/0/default.jpg`: `${url_prefix}/full/,${height}/0/default.jpg`
  const is_valid = isValidRoi(roi, viewer) || roi.label === 'Full Image';
  const crop_image = <AnchorButton
    onClick={onSelect}
    intent={selected ? Intent.PRIMARY : null}
    disabled={!is_valid}
    large={false}
    minimal={!selected}
    style={{ margin: "5px" }}
  >
    {/* an invalid ROI's thumbnail request would only fail */}
    <div>{is_valid ? <img src={src} alt={roi.label} height={height} width={height} /> : <div style={{height, width: height}} />}</div>
    <div>{!is_valid && <span style={{color: "red"}}>invalid</span>}{roi.label}</div>
    {roi.color && <Icon
      icon="full-circle"
      style={{color: roi.color.formatHex()}}
      title={roi.diff}
    ></Icon>}
  </AnchorButton>

  if (is_valid) {
    return crop_image
  }
  const tooltip_text = `Invalid coordinates for ${roi.label} ! ${JSON.stringify(roi)}`
  return <Tooltip
    intent={is_valid ? undefined : Intent.DANGER}
    content={<p align="center">{tooltip_text}</p>}
  >
    {crop_image}
  </Tooltip>
};


const fitTo = (roi, viewer, retry_on_viewer_update=true) => {
  if (roi.label === "Full Image") {
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

  const scaled = scale_roi(roi, viewer.source)
  const { x, y, width, height } = viewer.viewport.imageToViewportRectangle(scaled.x, scaled.y, scaled.w, scaled.h);
  const center = {
    x: x + width / 2,
    y: y + height / 2,
  };

  // best fit algorithm
  const { x: image_width, y: image_height } = viewer.world.getItemAt(0).getContentSize();
  const zoom = (Math.abs(scaled.w) > Math.abs(scaled.h)) ? image_width / Math.abs(scaled.w) : image_height / Math.abs(scaled.h);

  viewer.viewport.zoomTo(zoom);
  viewer.viewport.panTo(center);
};


const isValidRoi = (roi, viewer) => {
  if (roi.label === "Full Image")
    return true;
  if (isNaN(roi.x + roi.y + roi.w + roi.h))
    return false;

  const { x, y, w, h } = scale_roi(roi, viewer.source)
  const viewport_rec = viewer.viewport.imageToViewportRectangle(x, y, w, h);

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
      <Tooltip hoverCloseDelay={1000} content={<span>{to_clipboard}</span>}>
        <Button
          minimal
          style={{ marginRight: '5px', marginLeft: '5px' }}
          onClick={() => copyWithToast(to_clipboard, { what: 'the ROI' })}
        >
          <Icon
            icon="clipboard"
            intent={Intent.PRIMARY}
            size={IconSize.LARGE}
          />
        </Button>
      </Tooltip>
    )
  }
}

export { Crop, fitTo, isValidRoi, CropSelection, output_rois, scale_roi };
