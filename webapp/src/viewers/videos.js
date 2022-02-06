import React from "react";

import {
  Tag,
} from "@blueprintjs/core";

class SyncedVideos extends React.Component {
  constructor(props) {
    super(props);
    this.viewNewR = React.createRef();
    this.viewRefR = React.createRef();
  }
  play_ref = () => {
    if(!!this.props.output_ref && !!this.viewRefR.current)
      this.viewRefR.current.play()
  };
  pause_ref = () => {
    if(!!this.props.output_ref && !!this.viewRefR.current) {
      this.viewRefR.current.pause()
      this.syncReferenceVideo();
    }
  }
  canplay_ref = () => {
    this.ref_video_ready = true;
  };

  componentDidMount() { 
    this.viewNewR.current.addEventListener("play", this.play_ref);
    this.viewNewR.current.addEventListener("pause", this.pause_ref);

    this.viewNewR.current.addEventListener('timeupdate', this.syncReferenceVideo);
    this.viewNewR.current.addEventListener("seeked", this.syncReferenceVideoTwice);
    this.viewNewR.current.addEventListener('seeking', this.syncReferenceVideoTwice);
    this.viewNewR.current.addEventListener("waiting", this.syncReferenceVideoTwice);

    if(!!this.viewRefR.current)
      this.viewRefR.current.addEventListener("canplay", this.canplay_ref);
  }

  componentDidUpdate(prevProps, prevState) {
    const is_same_data = this.props.manifests?.new?.[this.props.path]?.md5 === this.props.manifests?.reference?.[this.props.path]?.md5
    const was_same_data = prevProps.manifests?.new?.[prevProps.path]?.md5 === prevProps.manifests?.reference?.[prevProps.path]?.md5
    if(was_same_data && !is_same_data && !!this.viewRefR.current)
      this.viewRefR.current.addEventListener("canplay", this.canplay_ref);
  }

  componentWillUnmount() {
    // Make sure to remove the DOM listener when the component is unmounted.
    if (!!this.viewRefR.current) {
      this.viewRefR.current.removeEventListener("loadedmetadata", this.canplay_ref);
    }
    if (!!this.viewNewR.current) {
      this.viewNewR.current.removeEventListener("play", this.play_ref);
      this.viewNewR.current.removeEventListener("pause", this.pause_ref);
      this.viewNewR.current.removeEventListener("timeupdate", this.syncReferenceVideo);
      this.viewNewR.current.removeEventListener("seeked", this.syncReferenceVideoTwice);      
      this.viewNewR.current.removeEventListener("seeking", this.syncReferenceVideoTwice);      
      this.viewNewR.current.removeEventListener("waiting", this.syncReferenceVideoTwice);      
    }
  }

  syncReferenceVideo = () => {
    if (this.ref_video_ready) {
      // console.log('befor:', this.viewNewR.current.currentTime, this.viewRefR.current.currentTime)
      this.viewRefR.current.currentTime = this.viewNewR.current.currentTime;
      // console.log('after:', this.viewNewR.current.currentTime, this.viewRefR.current.currentTime)
    }
  }

  syncReferenceVideoTwice = () => {
    if (this.ref_video_ready) {
      // console.log('befor:', this.viewNewR.current.currentTime, this.viewRefR.current.currentTime)
      this.viewRefR.current.currentTime = this.viewNewR.current.currentTime;
      // console.log('after:', this.viewNewR.current.currentTime, this.viewRefR.current.currentTime)
      setTimeout(100, () => {this.viewRefR.current.currentTime = this.viewNewR.current.currentTime})
      setTimeout(200, () => {this.viewRefR.current.currentTime = this.viewNewR.current.currentTime})
    }
  }

  render() {
    const { output_new, output_ref, path, poster='poster.jpg', type, manifests } = this.props;
    const is_same_data = manifests?.new?.[path]?.md5 === manifests?.reference?.[path]?.md5
    let width = parseFloat(((this.props.style || {}).width || '390px').replace(/[^\d]+/, ''))
    const single_video_width = (width - 10) / 2

    return (
      <>
        <div>
          <div><Tag intent="primary">new</Tag></div>
          <video
            ref={this.viewNewR}
            preload="none"
            controls
            loop="loop"
            title="New"
            width={single_video_width}
            poster={`${output_new.output_dir_url}/${poster}`}
            type={type}
          >
            <source src={`${output_new.output_dir_url}/${path}`} />
          </video>
        </div>
        {!!output_ref ? (
          <div>
            <div>
              <Tag intent="warning">{!is_same_data ? "reference" : 'reference (same-video)'}</Tag>
            </div>
            {!is_same_data && <video
              ref={this.viewRefR}
              controls
              preload="none"
              loop="loop"
              title="Reference"
              width={single_video_width}
              poster={`${output_ref.output_dir_url}/${poster}`}
              type={type}
            >
              <source src={`${output_ref.output_dir_url}/${path}`} />
            </video>}
          </div>
        ) : <span ref={this.viewRefR}/>}
      </>
    );
  }
}

export default SyncedVideos;
