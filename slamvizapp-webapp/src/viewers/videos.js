import React from "react";

class SyncedVideos extends React.Component {
  constructor(props) {
    super(props);
    this.syncReferenceVideo = this.syncReferenceVideo.bind(this);
  }
  play_ref = () => this.video_ref.play();
  pause_ref = () => this.video_ref.pause();
  canplay_ref = () => this.ref_video_ready = true;
  componentDidMount() {
    this.video_ref.addEventListener("canplay", this.canplay_ref);
    this.video_new.addEventListener("play", this.play_ref);
    this.video_new.addEventListener("pause", this.pause_ref);

    this.video_new.addEventListener('timeupdate', this.syncReferenceVideo);
    this.video_new.addEventListener('seeking', this.syncReferenceVideo);
  }

  componentWillUnmount() {
    // Make sure to remove the DOM listener when the component is unmounted.
    this.video_ref.removeEventListener("canplay", this.canplay_ref);
    this.video_new.removeEventListener("play", this.play_ref);
    this.video_new.removeEventListener("pause", this.pause_ref);

    this.video_new.removeEventListener("timeupdate", this.syncReferenceVideo);
    this.video_new.removeEventListener("seeking", this.syncReferenceVideo);

  }

  syncReferenceVideo() {
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
          ref={video => (this.video_new = video)}
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
        {output_ref && (
          <video
            ref={video => (this.video_ref = video)}
            preload="none"
            loop="loop"
            title="Reference"
            width={single_video_width}
            poster={`${output_ref.output_dir_url}/${poster}`}
            type={type}
          >
            <source src={`${output_ref.output_dir_url}/${path}`} />
          </video>
        )}
      </>
    );
  }
}

export default SyncedVideos;
