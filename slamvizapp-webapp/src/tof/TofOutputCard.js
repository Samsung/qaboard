import React, { Component } from "react";
// import { get, all, spread } from "axios";
import { Card, Icon, Tag, Intent, Popover } from "@blueprintjs/core";


class TofOutputCard extends Component {
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

    return <div style={{flex: '0 0 auto', marginBottom: '20px'}}>
      <Card className="output-card">
        <div style={{padding:'  '}}>
          <h5 style={{fontSize:'.7rem', fontWeight: 500, lineHeight: 1.6, letterSpacing: '-1px'}}>{output_new.test_input_path} {tags}</h5>
        </div>

        <p>{output_new.data.output_picture_format}</p>
        <div>
          <a href={`${output_new.output_dir_url}/${output_new.data.output_picture_format}`}><img width={400} alt='New' src={`${output_new.output_dir_url}/${output_new.data.output_picture_format}`} /></a>
          {output_ref.data && <a href={`${output_ref.output_dir_url}/${output_ref.data.output_picture_format}`}><img width={400} alt='Reference' src={`${output_ref.output_dir_url}/${output_ref.data.output_picture_format}`} /></a>}
        </div>

        <p><a href={`${output_new.output_dir_url}/${output_new.data.out_regs_file}`}>Output registers</a></p>
      </Card>
    </div>
  }

}


export { TofOutputCard };
