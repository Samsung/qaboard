// The file browser: a page of its own, light and fast, for the folders nginx serves under /s/
import { createRoot } from 'react-dom/client';
import { HotkeysProvider } from "@blueprintjs/core";

import "normalize.css";
import "@blueprintjs/core/lib/css/blueprint.css";
import "./files.css";

import FileBrowser from "./FileBrowser";

createRoot(document.getElementById('root')).render(
  <HotkeysProvider>
    <FileBrowser/>
  </HotkeysProvider>
);
