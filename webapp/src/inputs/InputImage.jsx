// An input in the image viewer (src/image-viewer): zoom, pixel values, histograms... Loaded on demand: OpenSeadragon is big.
import { ImageViewer } from '../image-viewer';
import { usePrefsStore } from '../stores/prefs';
import '../viewers/images/image-viewer-theme.css';


const InputImage = ({ image, notice, syncKey }) => {
  const pixel_values = usePrefsStore(state => state.imagePixelValues);
  const setPixelValues = usePrefsStore(state => state.setImagePixelValues);
  return <ImageViewer
    className="qaboard-image-viewer"
    style={{ width: '100%', maxWidth: '100%' }}
    image={image}
    // the values of the pixels the browser decoded: the server's are for runs' outputs
    pixelValues={pixel_values === 'image' ? 'display' : pixel_values}
    onPixelValuesChange={setPixelValues}
    imageValuesUnavailable="The image's own values are read from runs' outputs: here, the values shown are the displayed ones."
    syncKey={syncKey}
    theme="dark"
    maxHeight={height => height - 190}
    notice={notice}
  />;
};

export default InputImage;
