import React, { Fragment } from "react";

class SyncedVideos extends React.Component {
  constructor(props) {
    super(props);
    this.syncReferenceVideo = this.syncReferenceVideo.bind(this);
  }
  play_ref = () => this.video_ref.play();
  pause_ref = () => this.video_ref.pause();

  componentDidMount() {
    // this.video_ref.addEventListener("canplay",
    //   () => this.setState({ref_video_ready: true})
    // );
    this.video_new.addEventListener("play", this.play_ref);
    this.video_new.addEventListener("pause", this.pause_ref);
    // this.primary.addEventListener('timeupdate', this.syncReferenceVideo);
    // this.primary.addEventListener('seeking', this.syncReferenceVideo);
  }

  componentWillUnmount() {
    // Make sure to remove the DOM listener when the component is unmounted.
    // this.video_ref.removeEventListener("canplay");
    this.video_new.removeEventListener("play", this.play_ref);
    this.video_new.removeEventListener("pause", this.pause_ref);
  }

  syncReferenceVideo() {
    if (this.state.ref_video_ready)
      return (this.video_ref.currentTime = this.video_new.currentTime);
  }

  render() {
    const { output_new, output_ref, path, poster, type } = this.props;

    return (
      <Fragment>
        <video
          ref={video => (this.video_new = video)}
          preload="none"
          controls
          loop="loop"
          title="New"
          width={350}
          poster={`${output_new.output_dir_url}/${poster}`}
          type={type}
        >
          <source src={`${output_new.output_dir_url}/${path}`} />
        </video>
        {output_ref && (
          <video
            ref={video => (this.video_ref = video)}
            preload="none"
            loop="loop"
            title="Reference"
            width={(this.props.style && this.props.style.width) || 350}
            poster={`${output_ref.output_dir_url}/${poster}`}
            type={type}
          >
            <source src={`${output_ref.output_dir_url}/${path}`} />
          </video>
        )}
      </Fragment>
    );
  }
}

export default SyncedVideos;
