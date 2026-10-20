import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as THREE from "three";
import { Button, Checkbox, Colors } from "@blueprintjs/core";

import { fileQuery } from "../../api/queries";
import { OrbitControls } from "../tof/OrbitControls";
import { ViewerError } from "../ViewerStates";
import { parsePcd } from "./pcd";

// The same colors as the other viewers: the run in orange, the reference in blue, the ground truth in green
const LAYERS = [
  { key: 'groundtruth', label: 'Ground truth', color: Colors.GREEN4 },
  { key: 'reference', label: 'Reference', color: Colors.BLUE4 },
  { key: 'new', label: 'New', color: Colors.ORANGE4 },
];

const px = (value, fallback) => parseFloat(String(value ?? fallback).replace(/px$/, ''));

// stable, so that files are parsed once
const select = data => parsePcd(data);

const usePointCloud = (url, is_running) => {
  const query = useQuery({
    ...fileQuery(url, { is_running, responseType: 'arraybuffer' }),
    queryKey: ['file', url, 'arraybuffer'],
    select,
  });
  return url ? query : { isPending: false, data: undefined };
};


// Point clouds (PCD files) of the new run, its reference and an optional ground truth, on the same 3D axes, z up.
// Drag to orbit, right-drag to pan, scroll to zoom.
const PointCloudViewer = ({ output_new, output_ref, path, path_groundtruth, style, point_size = 2 }) => {
  const width = px(style?.width, 840);
  const height = px(style?.height, 480);
  const url = (output, file) => output?.output_dir_url && file ? `${output.output_dir_url}/${file}` : undefined;
  const clouds = {
    new: usePointCloud(url(output_new, path), output_new?.is_running),
    reference: usePointCloud(url(output_ref, path), output_ref?.is_running),
    groundtruth: usePointCloud(url(output_new, path_groundtruth), output_new?.is_running),
  };
  const [hidden, setHidden] = useState({});
  const canvas = useRef(null);
  const view = useRef(null);

  const loaded = LAYERS.filter(({ key }) => clouds[key].data?.count);
  const loaded_keys = loaded.map(({ key }) => key).join(',');
  const is_pending = Object.values(clouds).some(c => c.isPending && c.isFetching);

  // the scene, once the clouds are there
  const positions = useMemo(
    () => Object.fromEntries(loaded.map(({ key }) => [key, clouds[key].data.positions])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loaded_keys, clouds.new.data, clouds.reference.data, clouds.groundtruth.data],
  );
  useEffect(() => {
    if (!canvas.current || !Object.keys(positions).length) return;
    const renderer = new THREE.WebGLRenderer({ canvas: canvas.current, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height, false);
    const scene = new THREE.Scene();
    const box = new THREE.Box3();
    const points = {};
    for (const { key, color } of LAYERS) {
      if (!positions[key]) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions[key], 3));
      geometry.computeBoundingBox();
      box.union(geometry.boundingBox);
      const material = new THREE.PointsMaterial({ color, size: point_size, sizeAttenuation: false, transparent: true, opacity: 0.85 });
      points[key] = new THREE.Points(geometry, material);
      scene.add(points[key]);
    }
    // z up, seen from the south-west and above, the whole box in view
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getBoundingSphere(new THREE.Sphere()).radius || 1;
    const camera = new THREE.PerspectiveCamera(40, width / height, radius / 100, radius * 20);
    camera.up.set(0, 0, 1);
    const home = () => {
      camera.position.copy(center).add(new THREE.Vector3(-0.45, -1.1, 1.0).normalize().multiplyScalar(radius * 1.8));
      camera.lookAt(center);
    };
    home();
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(center);
    const render = () => renderer.render(scene, camera);
    controls.addEventListener('change', render);
    controls.update();
    render();
    view.current = {
      render,
      points,
      reset: () => { home(); controls.target.copy(center); controls.update(); render(); },
    };
    return () => {
      controls.dispose();
      Object.values(points).forEach(p => { p.geometry.dispose(); p.material.dispose(); });
      renderer.dispose();
      view.current = null;
    };
  }, [positions, width, height, point_size]);

  // layers shown or hidden without rebuilding the scene
  useEffect(() => {
    if (!view.current) return;
    for (const [key, p] of Object.entries(view.current.points))
      p.visible = !hidden[key];
    view.current.render();
  }, [hidden, positions]);

  if (clouds.new.isError) return <ViewerError path={path} error={clouds.new.error}/>;
  const is_ready = !is_pending && loaded.length > 0;
  return <div className="pointcloud-viewer" data-state={is_ready ? 'ready' : 'loading'} style={{ width }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 4 }}>
      {loaded.map(({ key, label, color }) =>
        <Checkbox
          key={key}
          inline
          style={{ marginBottom: 0 }}
          checked={!hidden[key]}
          onChange={() => setHidden({ ...hidden, [key]: !hidden[key] })}
          labelElement={<>
            <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 5, background: color, marginRight: 6 }}/>
            {label} <span className="bp6-text-muted">{clouds[key].data.count.toLocaleString()} points</span>
          </>}
        />
      )}
      {is_ready && <Button size="small" variant="minimal" icon="reset" onClick={() => view.current?.reset()}>Reset view</Button>}
    </div>
    <canvas ref={canvas} aria-label="Point clouds, in 3D" style={{ width, height, display: 'block', cursor: 'grab' }}/>
  </div>;
};

export default PointCloudViewer;
