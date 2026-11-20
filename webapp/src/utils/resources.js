// What a run used of its machine (qaboard/system_metrics.py): `qa run` and qaboard.start_run() sample it while the
// run runs, and send a summary with their heartbeats and the run's end (data.resources). The samples are plotted
// from system.series.json, in the run's folder. An earlier attempt keeps its peaks (data.previous_attempts[].resources).
// Sizes are in MiB (the *_mb keys), like LSF and nvidia-smi count them.

const number = value => typeof value === 'number' && Number.isFinite(value);

// 6963 -> "6.8 GiB", 512 -> "512 MiB": binary units, like LSF, Slurm and nvidia-smi count
export const memoryText = mb => {
  if (!number(mb)) return null;
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb >= 10 * 1024 ? 0 : 1)} GiB`;
  return `${Math.round(mb)} MiB`;
};

export const resourcesOf = output => {
  const resources = output?.data?.resources;
  return resources && typeof resources === 'object' && !Array.isArray(resources) ? resources : null;
};

const gpusOf = resources => (Array.isArray(resources?.gpus) ? resources.gpus : []).filter(gpu => gpu && typeof gpu === 'object');

// The peak memory of the run: its processes', else its cgroup's
export const peakMemory = resources => {
  const memory = resources?.memory ?? {};
  const processes = [memory.peak_mb, memory.max_process_mb].filter(number);
  if (processes.length) return Math.max(...processes);
  return number(memory.cgroup_peak_mb) ? memory.cgroup_peak_mb : null;
};

// "GPU 0: 87% · 21 GiB / 40 GiB": its mean utilization, the peak of the run's memory on it (else the GPU's, all its
// processes': in a container we don't know which are the run's), its size
export const gpuText = gpu => {
  const parts = [];
  if (number(gpu.utilization_mean)) parts.push(`${Math.round(gpu.utilization_mean)}%`);
  const used = number(gpu.run_memory_peak_mb) && gpu.run_memory_peak_mb > 0 ? gpu.run_memory_peak_mb : gpu.memory_peak_mb;
  if (number(used)) parts.push(number(gpu.memory_total_mb) ? `${memoryText(used)} / ${memoryText(gpu.memory_total_mb)}` : memoryText(used));
  return `GPU ${gpu.index ?? '?'}${parts.length ? `: ${parts.join(' · ')}` : ''}`;
};

// One line: "6.8 GB peak memory · 1.0 core · GPU 0: 87% · 21.3 / 24 GB". null when the run didn't say
export const resourcesText = output => {
  const resources = resourcesOf(output);
  if (!resources) return null;
  const parts = [];
  const memory = peakMemory(resources);
  if (number(memory)) parts.push(`${memoryText(memory)} peak memory`);
  const cores = resources.cpu?.mean_cores;
  if (number(cores)) parts.push(`${cores.toFixed(1)} core${cores.toFixed(1) === '1.0' ? '' : 's'}`);
  parts.push(...gpusOf(resources).map(gpuText));
  const kills = resources.memory?.oom_kills;
  if (number(kills) && kills > 0) parts.push('out of memory');
  return parts.length ? parts.join(' · ') : null;
};

// More details, e.g. for a tooltip: the host, the cgroup's limit, until when we know
export const resourcesDetails = output => {
  const resources = resourcesOf(output);
  if (!resources) return null;
  const memory = resources.memory ?? {};
  const lines = [];
  if (number(memory.peak_mb)) lines.push(`Peak memory of the run's processes, sampled every ${resources.interval_s ?? '?'}s: ${memoryText(memory.peak_mb)}`);
  if (number(memory.max_process_mb)) lines.push(`Peak memory of its biggest process: ${memoryText(memory.max_process_mb)}`);
  if (number(memory.cgroup_peak_mb)) lines.push(`Peak memory of its cgroup, with the files' cache: ${memoryText(memory.cgroup_peak_mb)}${number(memory.cgroup_limit_mb) ? ` (limit: ${memoryText(memory.cgroup_limit_mb)})` : ''}`);
  if (number(memory.cgroup_working_set_peak_mb)) lines.push(`Without the files' cache: ${memoryText(memory.cgroup_working_set_peak_mb)}`);
  if (number(memory.oom_kills) && memory.oom_kills > 0) lines.push(`Out of memory: the kernel killed ${memory.oom_kills} of its processes`);
  if (number(resources.cpu?.peak_cores)) lines.push(`CPU: ${resources.cpu.mean_cores?.toFixed?.(2) ?? '?'} cores on average, ${resources.cpu.peak_cores.toFixed(2)} at most`);
  for (const gpu of gpusOf(resources))
    lines.push(`${gpuText(gpu)}${typeof gpu.name === 'string' && gpu.name ? ` (${gpu.name})` : ''}${number(gpu.run_memory_peak_mb) ? '' : ', the memory of all its processes'}${number(gpu.power_mean_w) ? `, ${Math.round(gpu.power_mean_w)} W` : ''}${number(gpu.temperature_peak_c) ? `, up to ${Math.round(gpu.temperature_peak_c)}°C` : ''}`);
  const host = resources.host ?? {};
  const cpus = number(host.cpus) ? (number(host.allocated_cpus) && host.allocated_cpus < host.cpus ? `${host.allocated_cpus} of ${host.cpus} CPUs` : `${host.cpus} CPUs`) : null;
  if (typeof host.name === 'string') lines.push(`On ${host.name}${cpus ? ` (${cpus}${number(host.memory_mb) ? `, ${memoryText(host.memory_mb)}` : ''})` : ''}`);
  if (resources.updated_at) lines.push(`Last measured: ${resources.updated_at}`);
  return lines.join('\n');
};
