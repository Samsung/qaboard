import React, { Fragment } from "react";


class SyncedVideos extends React.Component {
  constructor(props) {
    super(props);
    this.syncReferenceVideo = this.syncReferenceVideo.bind(this);
  }
  play_ref = () => this.video_ref.play();
  pause_ref = ()=> this.video_ref.pause();

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
      return this.video_ref.currentTime = this.video_new.currentTime;
  }

  render () {
    const { src_new, src_ref, poster_new, poster_ref} = this.props;
    return <Fragment>
      <video ref={video => this.video_new = video}  preload="none" controls loop="loop" title="New" width={350} poster={poster_new} type="video/mp4">
        <source src={src_new} />
      </video>
      {src_ref &&
      <video ref={video => this.video_ref = video} preload="none" loop="loop" title="Reference" width={350} poster={poster_ref} type="video/mp4">
         <source src={src_ref} />
      </video>}
    </Fragment>
  }
}


export { SyncedVideos };