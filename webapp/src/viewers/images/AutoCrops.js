import React from "react";
import { post } from "axios";

import {
  Button,
  Tag,
  Intent,
  Toaster,
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


const toaster = Toaster.create();


let default_diff_type = "yiq"
const diff_type_options = [
  {type: "yiq", label: "YIQ"},
  {type: "ssim", label: "SSIM"},
  {type: "ciede2000", label: "CIE 2000"},
  {type: "cie76", label: "CIE 1976"},
  {type: "ciede94", label: "CIE 1994"},
]

class AutoCrops extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      is_loading: false,
      error: null,
      // https://scikit-image.org/docs/stable/api/skimage.color.html
      diff_type: default_diff_type,
      threshold: 1,
      roi_diameter: 0,
      num_rois: 20,
      send_report: false,
    }
  }


  render() {
    const { error } = this.state
    return <>
      <ControlGroup style={{marginTop: "10px", marginBottom: "10px"}}>
        <Button
          onClick={this.generateAutoRois}
          intent={Intent.PRIMARY}
          loading={this.state.is_loading}
          large={false}
          icon="multi-select"
          text="Find Regions of Interest"
          style={{ marginRight: "10px" }}
        />
        <HTMLSelect value={this.state.diff_type} onChange={e => {
          const diff_type = e.currentTarget.value
          this.setState({diff_type})
          default_diff_type = diff_type
        }}>
          {diff_type_options.map(type => <option key={type.type} value={type.type} >{type.label ?? type.type}</option>)}
        </HTMLSelect>
        {this.state.error && <Tag intent={Intent.DANGER}>Error: {JSON.stringify(this.state.error)}</Tag>}
        {false && <><Tooltip content=
          {<ul>
            <li>Threshold [%]</li>
            <li>hold 'alt' for minor step</li>
            <li>hold 'shift' for major step</li>
          </ul>}
          position={Position.TOP}>
          <NumericInput
            value={this.state.threshold}
            onValueChange={threshold => this.setState({ threshold })}
            max={100}
            min={0}
            minorStepSize={0.1}
            stepSize={1}
            majorStepSize={5}
            clampValueOnBlur={true}
            placeholder={"Threshold"}
            style={{ width: "95px" }}
            allowNumericCharactersOnly={true}
            onBlur={() => this.updateOnBlur("threshold", this.state.threshold, 1)}
            disabled={this.state.is_loading}
          />
        </Tooltip>
        <Tooltip content="Diameter of roi [px]" position={Position.TOP}>
          <NumericInput
            value={this.state.roi_diameter}
            onValueChange={roi_diameter => this.setState({ roi_diameter })}
            min={0}
            minorStepSize={10}
            stepSize={100}
            majorStepSize={1000}
            clampValueOnBlur={true}
            placeholder={"Diameter"}
            style={{ width: "85px" }}
            allowNumericCharactersOnly={true}
            onBlur={() => this.updateOnBlur("roi_diameter", this.state.roi_diameter, 0)}
            disabled={this.state.is_loading}
          />
        </Tooltip>
        <Tooltip content="Truncate to max number of rois" position={Position.TOP}>
          <NumericInput
            value={this.state.num_rois}
            onValueChange={num_rois => this.setState({ num_rois })}
            min={1}
            minorStepSize={1}
            stepSize={5}
            majorStepSize={10}
            clampValueOnBlur={true}
            placeholder={"No. of rois"}
            style={{ width: "85px" }}
            allowNumericCharactersOnly={true}
            onBlur={() => this.updateOnBlur("num_rois", this.state.num_rois, 20)}
            disabled={this.state.is_loading}
          />
        </Tooltip></>}
        <Tooltip content="Export the results to a document" position={Position.TOP}>
          <>
          {false && !this.props.rois.length &&
            <Checkbox
              label={<b>Export report</b>}
              checked={this.state.send_report}
              onChange={() => this.update("send_report", !this.state.send_report)}
              style={{ marginLeft: "10px" }}
            />
          }
          {false && !!this.props.rois.length &&
            <Button
              onClick={this.generateReport}
              large={false}
              icon="export"
              text={"Export report"}
              loading={this.state.is_loading}
              style={{ marginLeft: "10px" }}
            />
          }
          </>
        </Tooltip>
      </ControlGroup>
    </>
  }

  update = (attr, value) => { this.setState({ [attr]: value }) }

  updateOnBlur = (attr, value, default_value) => {
    if (isNaN(value)) {
      this.setState({ [attr]: default_value })
    }
  }

  generateAutoRois = () => {
    this.setState({ is_loading: true });
    const data = {
      output_dir_url_new: this.props.output_new.output_dir_url,
      output_dir_url_ref: this.props.output_ref.output_dir_url,
      path: this.props.path,
      diff_type: this.state.diff_type,
      threshold: this.state.threshold / 100.0,  // convert threshold from percentage to ratio.
      diameter: this.state.roi_diameter,
      count: this.state.num_rois || 20,
    };
    // post("http://planet31:9002/api/v1/output/diff/image", data) // for dev-staging
    post("/api/v1/output/image/diff", data)                          // for prod
      .then(res => {
        let regions_of_interest = res.data.map(blob => this.blobToRoi(blob))
        // regions_of_interest.sort((a, b) => b.w * b.h - a.w * a.h)
        this.props.updateRois(regions_of_interest)
        this.setState({
          is_loading: false,
          error: null,
        })
        if (regions_of_interest.length > 0) {
          if (this.state.send_report) {
            this.generateReport();
            this.setState({ send_report: false })
          }

          toaster.show({ message: `${regions_of_interest.length} Regions of Interest`, intent: Intent.PRIMARY, timeout: 3000 });
        }
        else {
          toaster.show({ message: "No results. Try using a lower threshold?", intent: Intent.WARNING, timeout: 3000 });
        }
      })
      .catch(error => {
        console.log(error)
        this.setState({
          is_loading: false,
          send_report: false,
          error,
        })
        toaster.show({ message: `${error}`, intent: Intent.DANGER, timeout: 3000 });
      })
  }

  blobToRoi = blob => {
    let {y, x, r, diff} = blob;
    // console.log(diff)
    // let scaled_diff = 1 - (diff / 35215 / (20));
    scaled_diff = Math.max(0, Math.min(1, diff));
    let scaled_diff = 1 - diff;
    let color = rgb(interpolateInferno(scaled_diff))
    let roi = {
      r,
      color,
      x: x,
      y: y,
      w: r,
      h: r,
      // x: x - r,
      // y: y - r,
      // w: 2 * r,
      // h: 2 * r,
    }

    const { viewer } = this.props;
    let { x: image_width, y: image_height } = viewer.world.getItemAt(0).getContentSize();

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


    // color.r, color.g, color.b
    // roi.w = Math.min(r, image_width - (roi.x + 2*r))
    // roi.h = Math.min(r, image_height - (roi.y + 2*r))
    // x + w < image_width
    // w < image_width - x
    // console.log(roi.x + 2*roi.w, image_width, (roi.x + 2*roi.w) > image_width)
    // if ((roi.x + 2*roi.w) > image_width) {
    //   console.log("correcting", (image_width - (roi.x + 2*roi.w)))
    //   roi.w = roi.w - (image_width - (roi.x + 2*roi.w))
    // }

    // console.log("H", (roi.y + 2*roi.h), image_width, (roi.y + 2*roi.h) > image_width)
    // if ((roi.y + 2*roi.h) > image_height) {
    //   roi.h = roi.h - (image_height - (roi.y + 2*roi.h))
    // }
    // roi.label = `${roi.diff}`
    // console.log(roi)
    return roi;
  }

  generateReport = () => {
    const data = {
      output_id_new: this.props.output_new.id,
      output_id_ref: this.props.output_ref.id,
      output_dir_url_new: this.props.output_new.output_dir_url,
      output_dir_url_ref: this.props.output_ref.output_dir_url,
      path: this.props.path,
    };

    this.setState({ is_loading: true });
    // post("http://planet31:9002/api/v1/output/diff/report", data) // for dev-staging
    post("/api/v1/output/diff/report", data)                 // for prod
      .then(res => {
        // console.log(res.data); // DEBUG
        let report = res.data
        this.setState({
          is_loading: false,
          error: null,
        })
        if (report) window.open(report, '_blank');
      })
  }

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