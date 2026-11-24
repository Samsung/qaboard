// A run's logged media (its media.jsonl, read by media.js), fetched once for the whole card: the "Logged media" section
// and the series plots' step cursor (viewers/series.jsx) share the query. While the run goes on, it's fetched again.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { fileQuery } from "../../api/queries";
import { useMediaContext } from "./context";
import { MEDIA_INDEX, parseMedia } from "./media";

// Running runs append to their files as they go
export const REFRESH_INTERVAL = 10 * 1000;

// A text file of a run, fetched again while it runs. Nothing without a path or a run.
export const useRunText = (output, path) => {
  const { fileUrl } = useMediaContext();
  const url = output && path ? fileUrl(output, path) : undefined;
  return useQuery({
    ...fileQuery(url, { is_running: output?.is_running, responseType: 'text' }),
    refetchInterval: output?.is_running ? REFRESH_INTERVAL : false,
  });
};

// { model, query }: model is the parsed file (media.js parseMedia), null until it's there, or when it can't be read.
// manifest: the run's files ({ [path]: ... }), when known: a run without the file isn't asked for it.
export const useMediaModel = (output, manifest, path = MEDIA_INDEX) => {
  const exists = !manifest || !!manifest[path];
  const query = useRunText(exists ? output : undefined, path);
  const data = query.isSuccess ? query.data : undefined;
  const model = useMemo(() => data !== undefined ? parseMedia(typeof data === 'string' ? data : '') : null, [data]);
  return { model, query, exists };
};
