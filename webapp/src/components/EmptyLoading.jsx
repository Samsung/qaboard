import { useEffect, useState } from "react";
import { Spinner } from "@blueprintjs/core";

// While a page's code downloads. Fast loads show nothing, slow ones a spinner: no flash either way.
const delay = 400;

const EmptyLoading = () => {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShow(true), delay);
    return () => clearTimeout(timer);
  }, []);
  return <div style={{ display: 'flex', justifyContent: 'center', padding: '20vh 0', minHeight: '60vh' }} aria-busy="true">
    {show && <Spinner size={32} aria-label="Loading"/>}
  </div>;
};

export default EmptyLoading;
