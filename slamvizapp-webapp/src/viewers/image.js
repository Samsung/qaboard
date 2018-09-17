import React, { PureComponent } from "react";


class ImgViewer extends PureComponent {
  // constructor(props) {
  //   super(props);
  //   this.state = {
  //   }
  // }
  render() {
    const { path, output_new, output_ref } = this.props;
    return <div>
      <img
        alt="New"
        src={`${output_new.output_dir_url}/${path}`}
        width={400}
      />
      <img
        alt="Reference"
        src={`${output_ref.output_dir_url}/${path}`}
        width={400}
      />
    </div>
  }

}

export default ImgViewer;
