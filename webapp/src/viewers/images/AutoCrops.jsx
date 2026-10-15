import { useState } from "react";

import {
  Button,
  Tag,
  Intent,
  ControlGroup,
  NumericInput,
  Position,
  Tooltip,
  Checkbox,
  HTMLSelect,
} from "@blueprintjs/core";
import {
  interpolateInferno,
} from 'd3-scale-chromatic'
import { rgb } from 'd3-color'
import { http, errorMessage } from "../../api/http"
import { toaster } from "../../toaster"


// The threshold/diameter/count inputs and the report export are currently hidden
const show_advanced_controls = false
const show_report_controls = false

let default_diff_type = "yiq"
const diff_type_options = [
  {type: "yiq", label: "YIQ"},
  {type: "ssim", label: "SSIM"},
  {type: "ciede2000", label: "CIE 2000"},
  {type: "cie76", label: "CIE 1976"},
  {type: "ciede94", label: "CIE 1994"},
]


// Converts a blob found by the server to a region of interest, clipped to the image
export const blobToRoi = (blob, image_width, image_height) => {
  const { y, x, r, diff } = blob;
  const scaled_diff = 1 - Math.max(0, Math.min(1, diff));
  const color = rgb(interpolateInferno(scaled_diff))
  const roi = {
    r,
    color,
    diff,
    x: x,
    y: y,
    w: r,
    h: r,
  }
  if (roi.x < 0) {
    roi.w = roi.w + x;
    roi.x = 0;
  }
  if (roi.y < 0) {
    roi.h = roi.h + y;
    roi.y = 0;
  }
  roi.w = (roi.x + roi.w < image_width) ? roi.w : image_width - roi.x;
  roi.h = (roi.y + roi.h < image_height) ? roi.h : image_height - roi.y;
  return roi;
}


const AutoCrops = ({ viewer, output_new, output_ref, path, rois, updateRois }) => {
  const [is_loading, setIsLoading] = useState(false)
  const [error, setError] = useState(null)
  // https://scikit-image.org/docs/stable/api/skimage.color.html
  const [diff_type, setDiffType] = useState(default_diff_type)
  const [threshold, setThreshold] = useState(1)
  const [roi_diameter, setRoiDiameter] = useState(0)
  const [num_rois, setNumRois] = useState(20)
  const [send_report, setSendReport] = useState(false)

  const generateReport = async () => {
    const data = {
      output_id_new: output_new.id,
      output_id_ref: output_ref.id,
      output_dir_url_new: output_new.output_dir_url,
      output_dir_url_ref: output_ref.output_dir_url,
      path,
    };
    setIsLoading(true)
    try {
      const { data: report } = await http.post("/api/v1/output/diff/report", data)
      setIsLoading(false)
      setError(null)
      if (report) window.open(report, '_blank');
    } catch (error) {
      setIsLoading(false)
      setError(error)
      toaster.show({ message: errorMessage(error), intent: Intent.DANGER, timeout: 3000 });
    }
  }

  const generateAutoRois = async () => {
    setIsLoading(true)
    const data = {
      output_dir_url_new: output_new.output_dir_url,
      output_dir_url_ref: output_ref.output_dir_url,
      path,
      diff_type,
      threshold: threshold / 100.0,  // convert threshold from percentage to ratio.
      diameter: roi_diameter,
      count: num_rois || 20,
    };
    try {
      const res = await http.post("/api/v1/output/image/diff", data)
      const { x: image_width, y: image_height } = viewer.world.getItemAt(0).getContentSize();
      const regions_of_interest = res.data.map(blob => blobToRoi(blob, image_width, image_height))
      updateRois(regions_of_interest)
      setIsLoading(false)
      setError(null)
      if (regions_of_interest.length > 0) {
        if (send_report) {
          generateReport();
          setSendReport(false)
        }
        toaster.show({ message: `${regions_of_interest.length} Regions of Interest`, intent: Intent.SUCCESS, timeout: 3000 });
      }
      else {
        toaster.show({ message: "No results. Try using a lower threshold?", intent: Intent.WARNING, timeout: 3000 });
      }
    } catch (error) {
      console.log(error)
      setIsLoading(false)
      setSendReport(false)
      setError(error)
      toaster.show({ message: errorMessage(error), intent: Intent.DANGER, timeout: 3000 });
    }
  }

  const resetIfNaN = (value, setValue, default_value) => {
    if (isNaN(value))
      setValue(default_value)
  }

  return <>
    <ControlGroup style={{marginTop: "10px", marginBottom: "10px"}}>
      <Button
        onClick={generateAutoRois}
        intent={Intent.PRIMARY}
        loading={is_loading}
        large={false}
        icon="multi-select"
        text="Find Regions of Interest"
        style={{ marginRight: "10px" }}
      />
      <HTMLSelect value={diff_type} onChange={e => {
        const diff_type = e.currentTarget.value
        setDiffType(diff_type)
        default_diff_type = diff_type
      }}>
        {diff_type_options.map(type => <option key={type.type} value={type.type} >{type.label ?? type.type}</option>)}
      </HTMLSelect>
      {error && <Tag intent={Intent.DANGER}>Error: {errorMessage(error)}</Tag>}
      {show_advanced_controls && <><Tooltip content={<ul>
          <li>Threshold [%]</li>
          <li>hold 'alt' for minor step</li>
          <li>hold 'shift' for major step</li>
        </ul>}
        position={Position.TOP}>
        <NumericInput
          value={threshold}
          onValueChange={setThreshold}
          max={100}
          min={0}
          minorStepSize={0.1}
          stepSize={1}
          majorStepSize={5}
          clampValueOnBlur={true}
          placeholder={"Threshold"}
          style={{ width: "95px" }}
          allowNumericCharactersOnly={true}
          onBlur={() => resetIfNaN(threshold, setThreshold, 1)}
          disabled={is_loading}
        />
      </Tooltip>
      <Tooltip content="Diameter of roi [px]" position={Position.TOP}>
        <NumericInput
          value={roi_diameter}
          onValueChange={setRoiDiameter}
          min={0}
          minorStepSize={10}
          stepSize={100}
          majorStepSize={1000}
          clampValueOnBlur={true}
          placeholder={"Diameter"}
          style={{ width: "85px" }}
          allowNumericCharactersOnly={true}
          onBlur={() => resetIfNaN(roi_diameter, setRoiDiameter, 0)}
          disabled={is_loading}
        />
      </Tooltip>
      <Tooltip content="Truncate to max number of rois" position={Position.TOP}>
        <NumericInput
          value={num_rois}
          onValueChange={setNumRois}
          min={1}
          minorStepSize={1}
          stepSize={5}
          majorStepSize={10}
          clampValueOnBlur={true}
          placeholder={"No. of rois"}
          style={{ width: "85px" }}
          allowNumericCharactersOnly={true}
          onBlur={() => resetIfNaN(num_rois, setNumRois, 20)}
          disabled={is_loading}
        />
      </Tooltip></>}
      {show_report_controls && <Tooltip content="Export the results to a document" position={Position.TOP}>
        <>
        {!rois.length &&
          <Checkbox
            label={<b>Export report</b>}
            checked={send_report}
            onChange={() => setSendReport(!send_report)}
            style={{ marginLeft: "10px" }}
          />
        }
        {!!rois.length &&
          <Button
            onClick={generateReport}
            large={false}
            icon="export"
            text={"Export report"}
            loading={is_loading}
            style={{ marginLeft: "10px" }}
          />
        }
        </>
      </Tooltip>}
    </ControlGroup>
  </>
}


/*
Keyboard interactions of NumericInput
↑/↓ - change the value by one step (default: ±1)
Shift + ↑/↓ - change the value by one major step (default: ±10)
Alt + ↑/↓ - change the value by one minor step (default: ±0.1)
Mouse interactions
Click ⌃/⌄ - change the value by one step (default: ±1)
Shift + Click ⌃/⌄ - change the value by one major step (default: ±10)
Alt + Click ⌃/⌄ - change the value by one minor step (default: ±0.1)
*/

export default AutoCrops;