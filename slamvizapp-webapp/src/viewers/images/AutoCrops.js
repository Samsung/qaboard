import React from "react";
import { post } from "axios";

import {
  Button,
  AnchorButton,
  Intent,
  Toaster,
  ControlGroup,
  NumericInput,
  Position,
  Tooltip,
} from "@blueprintjs/core";


import { fitTo } from "./crops";

const toaster = Toaster.create();


class AutoCrops extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      regions_of_interest: [],
      roi: null,
      is_loading: false,
      error: null,
      // default configuration for auto-ROI
      diff_type: 'rgb',
      threshold: 1,
      roi_diameter: 0,
      num_rois: 20,
      ...((props.auto_rois || [])[0] || {}),
    }
  }


  render() {
    const { output_new, viewer_new, output_ref, viewer_ref } = this.props;
    if (!!!output_new || !!!viewer_new || !!!viewer_ref || !!!output_ref || output_ref.deleted) return <span />

    const { regions_of_interest } = this.state;

    return <>
      <ControlGroup>
        <Button
          onClick={this.nextRoi}
          intent={Intent.PRIMARY}
          large={false}
          text={"next"}
          style={{ marginRight: "10px" }}
        />
        <Button
          onClick={this.generateAutoRois}
          intent={Intent.PRIMARY}
          loading={this.state.is_loading}
          large={false}
          icon="multi-select"
          text={"Find Regions of Interest"}
          style={{ marginRight: "10px" }}
        />
        <Tooltip content="Threshold %" position={Position.TOP}>
          <NumericInput
            value={this.state.threshold}
            onValueChange={threshold => this.setState({ threshold })}
            max={100}
            min={0}
            minorStepSize={0.5}
            stepSize={0.5}
            majorStepSize={5}
            clampValueOnBlur={true}
            placeholder={"Threshold%"}
            style={{ width: "95px" }}
            allowNumericCharactersOnly={true}
            onBlur={() => this.updateOnBlur("threshold", this.state.threshold, 1)}
          />
        </Tooltip>
        <Tooltip content="diameter of roi" position={Position.TOP}>
          <NumericInput
            value={this.state.roi_diameter}
            onValueChange={roi_diameter => this.setState({ roi_diameter })}
            min={0}
            minorStepSize={10}
            stepSize={100}
            majorStepSize={1000}
            clampValueOnBlur={true}
            placeholder={"diameter"}
            style={{ width: "85px" }}
            allowNumericCharactersOnly={true}
            onBlur={() => this.updateOnBlur("roi_diameter", this.state.roi_diameter, 0)}
          />
        </Tooltip>
        <Tooltip content="max numbers of rois" position={Position.TOP}>
          <NumericInput
            value={this.state.num_rois}
            onValueChange={num_rois => this.setState({ num_rois })}
            min={1}
            minorStepSize={1}
            stepSize={5}
            majorStepSize={10}
            clampValueOnBlur={true}
            placeholder={"no. rois"}
            style={{ width: "85px" }}
            allowNumericCharactersOnly={true}
            onBlur={() => this.updateOnBlur("num_rois", this.state.num_rois, 20)}
          />
        </Tooltip>
      </ControlGroup>

      <div>
        {regions_of_interest.map((roi, idx) => {
          return <AnchorButton
            onClick={() => { this.setState({ roi: roi }); fitTo(roi, viewer_new); }}
            style={{ margin: "5px" }}
            key={idx}
            intent={this.state.roi === roi ? Intent.PRIMARY : null}
          >
            {roi.label || roi.tag || idx}
          </AnchorButton>
        })}
      </div>
    </>
  }

  updateOnBlur = (attr, value, default_value) => {
    if (isNaN(value)) {
      this.setState({ [attr]: default_value })
    }
  }

  nextRoi = () => {
    const { viewer_new } = this.props;
    const { regions_of_interest } = this.state;

    for (let i = 0; i < regions_of_interest.length; i++) {
      if (this.state.regions_of_interest[i] == this.state.roi) {
        this.setState({ roi: regions_of_interest[i + 1] })
        fitTo(this.state.roi, viewer_new)
      }
    }
  }
  generateAutoRois = () => {
    const data = {
      output_id_new: this.props.output_new.id,
      output_id_ref: this.props.output_ref.id,
      output_dir_url_new: this.props.output_new.output_dir_url,
      output_dir_url_ref: this.props.output_ref.output_dir_url,
      path: this.props.path,
      diff_type: this.state.diff_type,
      threshold: this.state.threshold,
      diameter: this.state.roi_diameter,
      count: this.state.num_rois,
    };

    this.setState({ is_loading: true });
    post("http://planet31:9002/api/v1/output/diff/image", data) // for DEBUG
      //post("/api/v1/output/diff/image", data)
      .then(res => {
        //console.log(res.data);
        let regions_of_interest = res.data.map(blob => this.blobToRoi(blob))
        regions_of_interest.sort((a, b) => b.w * b.h - a.w * a.h)

        this.setState({
          regions_of_interest,
          is_loading: false,
          error: null,
        })
        if (regions_of_interest.length > 0) {
          toaster.show({ message: `${regions_of_interest.length} Regions of Interest`, intent: Intent.PRIMARY, timeout: 3000 });
        } else {
          toaster.show({ message: "No results. Try using a lower threshold?", intent: Intent.WARNING, timeout: 3000 });
        }
      })
      .catch(error => {
        this.setState({
          regions_of_interest: [],
          is_loading: false,
          error,
        })
        toaster.show({ message: `${error}`, intent: Intent.DANGER, timeout: 3000 });
      })
  }


  blobToRoi = blob => {
    let [y, x, r] = blob;

    let roi = {
      x: x - r,
      y: y - r,
      w: 2 * r,
      h: 2 * r,
      label: `${this.state.diff_type}(${x}, ${y})`
    }

    const { viewer_new } = this.props;
    let { x: image_width, y: image_height } = viewer_new.world.getItemAt(0).getContentSize();

    // roi.x = Math.min(Math.max(x, 0), image_width);
    // roi.y = Math.min(Math.max(y, 0), image_height);

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