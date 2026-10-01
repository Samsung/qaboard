import React from "react";
import GenericTextViewer from "./text";


class TextViewer extends React.PureComponent {
  render() {
    const { output_new, output_ref, path, ...props } = this.props;
    // const { style } = this.props;
    // const width_px = (!!style && style.width) || '400px';
    // const width = parseFloat(width_px.substring(0, width_px.length-2)) - 10;
    
    return <GenericTextViewer
            text_url_new={(!!output_new && !!output_new.output_dir_url) ? `${output_new.output_dir_url}/${path}` : null}
            text_url_ref={(!!output_ref && !!output_ref.output_dir_url) ? `${output_ref.output_dir_url}/${path}` : null}
            filename={path}
            {...props}
           />
            // width={width}
  }
}


export default TextViewer;
