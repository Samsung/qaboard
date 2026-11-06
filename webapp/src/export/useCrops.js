// The regions of interest to crop, for the export: from the image viewer's providers (presets, where the images
// differ, the site's annotations...), and quarters. Regions found on demand are the viewers' queries
// (viewers/images/regionSearch.js): what a viewer or "Where they differ" found is there already, and what the export
// finds shows in the viewers.
import { useMemo } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';

import { useSiteConfig, useUser } from '../hooks';
import { annotationProvider, regionProviders } from '../viewers/images/regionProviders';
import { regionsQuery, sizeKey } from '../viewers/images/regionSearch';
import { useRegionSetStore } from '../viewers/images/regionSetStore';
import { useDiffSize } from '../viewers/images/DiffSize';
import { QUARTERS, crop_regions, glob_regex, is_single_file } from './plan';

export const QUARTERS_ID = 'quarters';
// Regions found automatically, e.g. where images differ, can be many: by default the export keeps the largest 5 of each
// image (they come largest first). Presets and annotations are regions people chose: all of them.
export const DEFAULT_MAX_FOUND = 5;
export const MAX_FOUND = 20;
export const is_found_automatically = provider => !!(provider.diff_type || provider.sized);

// [{ output_new, output_ref }] for the runs shown
const run_contexts = (new_batch, ref_batch) => (new_batch?.filtered?.outputs ?? [])
  .map(id => new_batch.outputs[id])
  .filter(Boolean)
  .map(output => {
    const ref = output.reference_id && output.reference_id !== output.id ? ref_batch?.outputs?.[output.reference_id] : null;
    return { output_new: output, output_ref: ref && !ref.deleted && ref.output_dir_url ? ref : null };
  });

// Providers give arrays, or {groups, regions} (annotations)
const as_regions = data => Array.isArray(data) ? data : (data?.regions ?? []);

// The region sets the viewers of these files show: the export starts with them
export const useShownRegionSets = files => {
  const by_path = useRegionSetStore(state => state.by_path);
  return useMemo(() => {
    let regex;
    try { regex = glob_regex(files); } catch { return []; }
    return [...new Set(Object.entries(by_path).filter(([path, chosen]) => chosen?.id && regex.test(path)).map(([, chosen]) => chosen.id))];
  }, [by_path, files]);
};

/**
 * The sources of regions, and the regions to crop of each new run.
 * picked: the ids of the sources users picked, or null: the sets the viewers show (`shown`), else the presets.
 * max_found: how many regions found automatically (where images differ) to keep per image, the largest first.
 * Returns {picked, sources, regions: Map(run id => [regions]), finding, start(id), stop(id)}
 * sources: [{id, label, description, kind: 'known' | 'find' | 'quarters', section, disabled (why), runs (with regions),
 *            regions (count), searched, total, fetching, failed}]
 */
export const useCrops = ({ enabled, picked: chosen, shown = [], files, new_batch, ref_batch, max_found = DEFAULT_MAX_FOUND }) => {
  const { annotation_sources } = useSiteConfig();
  const signed_in = useUser().is_logged;
  const [diff_size] = useDiffSize();
  const queryClient = useQueryClient();
  const single = is_single_file(files);
  const size_key = JSON.stringify(sizeKey(diff_size));
  // oxlint-disable-next-line react/exhaustive-deps -- by their value
  const contexts = useMemo(() => run_contexts(new_batch, ref_batch).map(c => ({ ...c, path: files, path_ref: files, diff_size })), [new_batch, ref_batch, files, size_key]);
  const providers = [...regionProviders(), ...(annotation_sources ?? []).map(annotationProvider)];

  // why a source can't be used for these runs, or null
  const disabled_of = provider => {
    if (provider.diff_type || provider.sized) {
      if (!single) return 'Finds where one file differs: set Files to one file, e.g. out.png, not a pattern';
      if (!signed_in) return 'Sign in (in the sidebar) to find where the images differ';
    }
    if (provider.find && !signed_in) return 'Sign in (in the sidebar) to find these regions';
    if (!contexts.some(c => !provider.available || provider.available(c))) return provider.diff_type ? 'These runs have no reference to compare with' : 'Not available for these runs';
    return null;
  };
  const has_presets = () => {
    const presets = providers.find(p => p.id === 'presets');
    return !!presets?.regions && contexts.some(c => presets.regions(c)?.length);
  };
  const picked = chosen ?? (shown.length > 0 ? shown : has_presets() ? ['presets'] : []);
  const finders = enabled ? providers.filter(p => !p.regions && p.find && picked.includes(p.id) && !disabled_of(p)) : [];
  const queries = finders.flatMap(provider => contexts
    .filter(c => !provider.available || provider.available(c))
    .map(c => ({ provider, context: c, query: { ...regionsQuery(provider, c), enabled: false } })));
  const results = useQueries({ queries: queries.map(q => q.query) });

  const sources = [];
  const regions = new Map();
  const add = (run_id, source, list, file) => {
    if (!list?.length) return;
    if (!regions.has(run_id)) regions.set(run_id, []);
    regions.get(run_id).push([source, list, file]);
  };
  for (const provider of providers) {
    const disabled = disabled_of(provider);
    const is_picked = enabled && picked.includes(provider.id) && !disabled;
    const base = { id: provider.id, label: provider.label, description: provider.description, section: provider.section, disabled, kind: provider.regions ? 'known' : 'find' };
    if (provider.regions) {
      let runs = 0, count = 0;
      for (const c of contexts) {
        if (provider.available && !provider.available(c)) continue;
        const list = provider.regions(c) ?? [];
        if (list.length) { runs++; count += list.length; }
        if (is_picked) add(c.output_new.id, provider.id, list, null);
      }
      // known regions only show when some runs have them
      if (runs === 0) continue;
      sources.push({ ...base, runs, regions: count, searched: contexts.length, total: contexts.length });
      continue;
    }
    if (!provider.find) continue;
    const mine = queries.map((q, i) => [q, results[i]]).filter(([q]) => q.provider === provider);
    let runs = 0, count = 0, found = 0, searched = 0, fetching = 0, failed = 0;
    const automatic = is_found_automatically(provider);
    for (const [{ context }, result] of mine) {
      if (result.fetchStatus === 'fetching') fetching++;
      if (result.data) {
        searched++;
        const all = as_regions(result.data);
        const list = automatic ? all.slice(0, max_found) : all;
        found += all.length;
        if (list.length) { runs++; count += list.length; }
        // where two images differ: regions of that file
        add(context.output_new.id, provider.id, list, provider.diff_type ? files : null);
      } else if (result.error) failed++;
    }
    const total = contexts.filter(c => !provider.available || provider.available(c)).length;
    sources.push({ ...base, automatic, runs, regions: count, found, searched, total, fetching, failed });
  }
  sources.push({
    id: QUARTERS_ID, label: 'Quarters', kind: 'quarters', experimental: true, disabled: null,
    description: 'The 4 quarters of each image: top-left, top-right, bottom-left, bottom-right', runs: contexts.length, regions: 4 * contexts.length,
  });
  if (enabled && picked.includes(QUARTERS_ID))
    for (const c of contexts) add(c.output_new.id, QUARTERS_ID, QUARTERS, null);

  const named = new Map([...regions].map(([id, by_source]) => [id, crop_regions(by_source)]));
  const start = id => {
    const provider = providers.find(p => p.id === id);
    if (!provider?.find || disabled_of(provider)) return;
    for (const c of contexts) {
      if (provider.available && !provider.available(c)) continue;
      queryClient.fetchQuery(regionsQuery(provider, c)).catch(() => {});
    }
  };
  const stop = id => queryClient.cancelQueries({ queryKey: ['image-regions', id] });
  return {
    picked,
    sources,
    regions: enabled ? named : null,
    finding: sources.filter(s => picked.includes(s.id) && s.fetching > 0),
    start,
    stop,
  };
};
