import React, { PureComponent } from "react";


class ImgViewer extends PureComponent {
  // constructor(props) {
  //   super(props);
  //   this.state = {
  //   }
  // }
  render() {
    const { path, output_new, output_ref } = this.props;
    let new_url = `${output_new.output_dir_url}/${path}`
    let ref_url = `${output_ref.output_dir_url}/${path}`
    return <div>
      <a href={new_url}>
        <img
          alt="New"
          src={new_url}
          width={400}
        />
      </a>
      <a href={ref_url}>
        <img
          alt="Reference"
          src={ref_url}
          width={400}
        />
      </a>
    </div>
  }

}

export default ImgViewer;
