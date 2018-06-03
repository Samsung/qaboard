import React, { Component } from "react";
// import { get, all, spread } from "axios";
import { Card, Icon, Tag, Intent, Popover } from "@blueprintjs/core";


class CisOutputCard extends Component {
  constructor(props) {
    super(props);
    this.state = {
      is_loaded: false,
    }
  }

  render() {
    const { output_new, output_ref, warning } = this.props;

    let tags = <span>
      <Tag intent={Intent.PRIMARY} className="pt-round pt-minimal">{output_new.platform}</Tag>
      <Tag intent={Intent.PRIMARY} className="pt-round pt-minimal">{output_new.configuration}</Tag>
      <a title="Show output files" style={{paddingLeft: '8px'}} target="_blank" href={output_new.output_dir_url}><Icon icon="download"/></a>
      {Object.entries(output_new.extra_parameters).map(([k,v]) =>
        <Tag key={k} intent={Intent.PRIMARY} className="pt-round pt-minimal">{k}:{v}</Tag>
      )}
      {warning && <Popover interactionKind='hover'><Icon intent={Intent.WARNING} icon='warning-sign' /><span>{warning}</span></Popover>}      
    </span>


    // loading DNJ (HEX???) image: http://dev.tag.is/rawson.js/
    // 1c 1c 1c
    // 1c 1c 1c
    // 1c 1c 1c
    // 1c 1c 1c
    // 1c 1c 1c
    // .. .. ..
    // <!--file_info
    // BitMask=1023
    // FileName=/stage/algo_data/Dual_Camera/4H8-3L8_Iphone7_DB/20-11-16_DB_Raw/S04_led01_w70_t110_slave_wide.hex
    // FullHeight=2464
    // FullWidth=3280
    // XOffset=0
    // YOffset=0
    // d_max=81
    // d_min=64
    // format=RGB888LONG
    // height=658
    // size_crop_x=3280
    // size_crop_y=2464
    // start_crop_x=0
    // start_crop_y=0
    // wb_gain_b=1743
    // wb_gain_g=1024
    // wb_gain_r=2286
    // width=874
    // file_info-->


    // https://github.com/mapbox/pixelmatch
    // there is also  https://github.com/HuddleEng/Resemble.js
    // but it doesn't look that great, and <3 mapbox

    // https://github.com/cezary/react-image-diff


    // http://blueprintjs.com/docs/v2/#core/components/dialog
    return <div style={{flex: '0 0 auto', marginBottom: '20px'}}>
      <Card className="output-card">
        <div style={{padding:'  '}}>
          <h5 style={{fontSize:'.7rem', fontWeight: 500, lineHeight: 1.6, letterSpacing: '-1px'}}>{output_new.test_input_path} {tags}</h5>
        </div>

        <p>{output_new.data.output_picture_format}</p>
        <div>
          <img width={400} alt='New' src={`${output_new.output_dir_url}/${output_new.data.output_picture_format}`} />
          {output_ref.data && <img width={400} alt='Reference' src={`${output_ref.output_dir_url}/${output_ref.data.output_picture_format}`} />}
        </div>

        <p><a href={`${output_new.output_dir_url}/${output_new.data.out_regs_file}`}>Output registers</a></p>
      </Card>
    </div>
  }

}


export { CisOutputCard };
