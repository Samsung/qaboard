import { useState, useEffect, useRef } from 'react';
import { Tag } from '@blueprintjs/core';

import { is_same_data } from "../utils"

const SyncedVideos = ({
  output_new,
  output_ref,
  path,
  poster = 'poster.jpg',
  type,
  style,
  manifests,
}) => {
  // the viewer for the new video is always shown
  const viewer_new_ref = useRef(null);

  // but it's not the case for the reference
  const viewer_reference_ref = useRef(null);
  const [show_reference, setShowReference] = useState(false);

  const syncInterval = useRef(null);
  const frameRate = 30; // Adjust this based on your video's frame rate
  const frameDuration = 1 / frameRate;

  const [currentTimeNew, setCurrentTimeNew] = useState(0);
  const [currentTimeRef, setCurrentTimeRef] = useState(0);

  const meta_new = manifests?.new?.[path]
  const meta_reference = manifests?.reference?.[path]
  const hasSameData = is_same_data(path, meta_new, meta_reference);

  const show_reference_updated = !!output_ref && !hasSameData
  if (show_reference !== show_reference_updated) {
    setShowReference(show_reference_updated)
  }

  useEffect(() => {
    const handleTimeUpdate = () => {
      if (viewer_reference_ref.current) {
        setCurrentTimeRef(viewer_reference_ref.current.currentTime);
      }
    };
    if (viewer_reference_ref.current) { // normally should be always true
      viewer_reference_ref.current.addEventListener("timeupdate", handleTimeUpdate);
      viewer_reference_ref.current.addEventListener('play', handlePlayRef);
      viewer_reference_ref.current.addEventListener('pause', handlePauseRef);
    }
    // cleanup on unmount
    return () => {
      if (viewer_reference_ref.current) { // normally should be always true
        viewer_reference_ref.current.removeEventListener("timeupdate", handleTimeUpdate);
        viewer_reference_ref.current.removeEventListener('play', handlePlayRef);
        viewer_reference_ref.current.removeEventListener('pause', handlePauseRef);
      }
    };
  }, [show_reference])

 
  useEffect(() => {
    const handleTimeUpdate = () => {
      if (viewer_new_ref.current) {
        setCurrentTimeNew(viewer_new_ref.current.currentTime);
      }
    };
    if (viewer_new_ref.current) { // always true since unconditionnaly rendered
      viewer_new_ref.current.addEventListener("timeupdate", handleTimeUpdate);

      viewer_new_ref.current.addEventListener('play', handlePlayRef);
      viewer_new_ref.current.addEventListener('pause', handlePauseRef);
    }
    // cleanup on unmount
    return () => {
      if (viewer_new_ref.current) {
        viewer_new_ref.current.removeEventListener("timeupdate", handleTimeUpdate);
        viewer_new_ref.current.removeEventListener('play', handlePlayRef);
        viewer_new_ref.current.removeEventListener('pause', handlePauseRef);
      }
      if (syncInterval.current) {
        cancelAnimationFrame(syncInterval.current);
      }
    };
  }, []);

  const handlePlayRef = () => {
    if (viewer_new_ref.current) {
      let play_promise_new = viewer_new_ref.current.play();
      play_promise_new.then(_ => {
        // console.log("play started (new)")
      })
      .catch(error => {
        console.log("Error when playing (new)", error)
      })
    }
    if (viewer_reference_ref.current) {
      syncInterval.current = requestAnimationFrame(syncVideos);
      let play_promise_ref = viewer_reference_ref.current.play();
      play_promise_ref.then(_ => {
        // console.log("play started (ref)")
      })
      .catch(error => {
        console.log("Error when playing (ref)", error)
      })
    } else {
      console.log("SKIPPED SYNC")
    }
  };

  const handlePauseRef = () => {
    if (viewer_new_ref.current) {
      viewer_new_ref.current.pause();
    }
    if (viewer_reference_ref.current) {
      viewer_reference_ref.current.pause();
      syncReferenceVideo();
    }
    if (syncInterval.current) {
      cancelAnimationFrame(syncInterval.current)
      setTimeout(syncReferenceVideo, 100)
    }
  };

  const syncVideos = () => {
    syncReferenceVideo()
    syncInterval.current = requestAnimationFrame(syncVideos)
  }

  const syncReferenceVideo = () => {
    if (viewer_reference_ref.current && viewer_new_ref.current && viewer_reference_ref.current.readyState >= 1) {
      const time_difference = Math.abs(viewer_reference_ref.current.currentTime - viewer_new_ref.current.currentTime);
      if (time_difference > frameDuration) {
        console.log("SYNC ", time_difference)
        viewer_reference_ref.current.currentTime = viewer_new_ref.current.currentTime;
      }
      // If one is paused, pause the other
      // if (viewer_new_ref.current.paused !== viewer_reference_ref.current.paused) {
      //   if (viewer_new_ref.current.paused) viewer_reference_ref.current.pause();
      //   else viewer_reference_ref.current.play();
      // }
    }
  };

  const width = parseFloat(((style?.width ?? '390px').replace(/[^\d]+/, '')))
  const singleVideoWidth = (width - 10) / 2;

  return (
    <>
      <div>
        <div>
          <Tag intent="primary">new <code>@{currentTimeNew}s</code></Tag>
        </div>
        <video
          ref={viewer_new_ref}
          preload="none"
          controls
          loop="loop"
          title="New"
          width={singleVideoWidth}
          poster={`${output_new.output_dir_url}/${poster}`}
          type={type}
        >
          <source src={`${output_new.output_dir_url}/${path}`} />
        </video>
      </div>
      {output_ref ? (
        <div>
          <div>
            <Tag intent="warning">
              {!hasSameData ? 'reference' : 'reference (same-video)'}
              {Math.abs(currentTimeNew-currentTimeRef) > frameDuration!==0 && <code>
                {currentTimeNew - currentTimeRef > 0 ? " -" : " +"}
                {(Math.abs(currentTimeNew-currentTimeRef)*1000).toPrecision(3)}ms
              </code>}
            </Tag>
          </div>
          {!hasSameData && (
            <video
              ref={viewer_reference_ref}
              controls
              preload="none"
              loop="loop"
              title="Reference"
              width={singleVideoWidth}
              poster={`${output_ref.output_dir_url}/${poster}`}
              type={type}
            >
              <source src={`${output_ref.output_dir_url}/${path}`} />
            </video>
          )}
        </div>
      ) : (
        <span ref={viewer_reference_ref} />
      )}
    </>
  );
};

export default SyncedVideos;