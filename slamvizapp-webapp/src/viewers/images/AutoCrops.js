import React from "react";
import { post } from "axios";

import {
  Button,
  AnchorButton,
  Intent,
  Toaster,
  ControlGroup,
  NumericInput,
} from "@blueprintjs/core";


import { fitTo } from "./crops";

const toaster = Toaster.create();

class AutoCrops extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      regions_of_interest: [],
      is_loading: false,
      error: null,
      // default configuration for auto-ROI
      diff_type: 'rgb',
      threshold: 0.1,
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
          onClick={this.generateAutoRois}
          intent={Intent.PRIMARY}
          loading={this.state.is_loading}
          large={false}
          icon="multi-select"
          text={"Find Regions of Interest"}
          style={{ marginRight: "10px" }}
        />
        <NumericInput
          value={this.state.threshold}
          onValueChange={this.updateThreshold}
          max={1}
          min={0}
          majorStepSize={0.1}
          minorStepSize={0.005}
          stepSize={0.01}
          clampValueOnBlur={true}
          placeholder={"Enter a threshold..."}
          style={{ width: "70px" }}

        />
      </ControlGroup>

      <div>
        {regions_of_interest.map((roi, idx) => {
          // let is_selected = true; // viewer_new.coordinates === roi.coordinates
          return <AnchorButton
            onClick={() => { fitTo(roi, viewer_new) }}
            style={{ margin: "5px" }}
            key={idx}
          >
            {roi.label || roi.tag || idx}
          </AnchorButton>
        })}
      </div>
    </>
  }

  updateThreshold = threshold => {
    this.setState({ threshold });
  }


  generateAutoRois = () => {
    const data = {
      output_id_new: this.props.output_new.id,
      output_id_ref: this.props.output_ref.id,
      output_dir_url_new: this.props.output_new.output_dir_url,
      output_dir_url_ref: this.props.output_ref.output_dir_url,
      path: this.props.path,
      diff_type: this.state.diff_type,
      threshold: this.state.threshold
    };

    this.setState({ is_loading: true });
    //post("http://planet31:9002/api/v1/output/diff/image", data) // for DEBUG
    post("/api/v1/output/diff/image", data)
      .then(res => {
        //console.log(res.data);
        let regions_of_interest = res.data.map(blob => this.blobToRoi(blob))
        //console.debug(regions_of_interest)

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

    roi.x = Math.min(Math.max(x, 0), image_width);
    roi.y = Math.min(Math.max(y, 0), image_height);
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