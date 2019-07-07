import React from "react";

class SyncedVideos extends React.Component {
  constructor(props) {
    super(props);
    this.viewNewR = React.createRef();
    this.viewRefR = React.createRef();
  }
  play_ref = () => !!this.props.output_ref && !!this.viewRefR.current && this.viewRefR.current.play();
  pause_ref = () => !!this.props.output_ref && !!this.viewRefR.current && this.viewRefR.current.pause();
  canplay_ref = () => this.ref_video_ready = true;
  componentDidMount() { 
    this.viewRefR.current.addEventListener("canplay", this.canplay_ref);
    this.viewNewR.current.addEventListener("play", this.play_ref);
    this.viewNewR.current.addEventListener("pause", this.pause_ref);

    this.viewNewR.current.addEventListener('timeupdate', this.syncReferenceVideo);
    this.viewNewR.current.addEventListener('seeking', this.syncReferenceVideo);
  }

  componentWillUnmount() {
    // Make sure to remove the DOM listener when the component is unmounted.
    if (!!this.viewNewR.current) {
      this.viewNewR.current.removeEventListener("play", this.play_ref);
      this.viewNewR.current.removeEventListener("pause", this.pause_ref);
      this.viewNewR.current.removeEventListener("timeupdate", this.syncReferenceVideo);
      this.viewNewR.current.removeEventListener("seeking", this.syncReferenceVideo);      
    }
    if (!!this.viewRefR.current) {
      this.viewRefR.current.removeEventListener("canplay", this.canplay_ref);
    }
  }

  syncReferenceVideo = () => {
    if (this.ref_video_ready)
      return (this.video_ref.currentTime = this.video_new.currentTime);
  }

  render() {
    const { output_new, output_ref, path, poster='poster.jpg', type } = this.props;
    let width = parseFloat(((this.props.style || {}).width || '390px').replace(/[^\d]+/, ''))
    const single_video_width = (width - 10) / 2

    return (
      <>
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
        {!!output_ref ? (
          <video
            ref={this.viewRefR}
            preload="none"
            loop="loop"
            title="Reference"
            width={single_video_width}
            poster={`${output_ref.output_dir_url}/${poster}`}
            type={type}
          >
            <source src={`${output_ref.output_dir_url}/${path}`} />
          </video>
        ) : <span ref={this.viewRefR}/>}
      </>
    );
  }
}

export default SyncedVideos;
