/**
 * What a run used of its machine (data.resources, from qaboard/system_metrics.py).
 * Run with: cd webapp && npm test -- resources
 */
import { gpuText, memoryText, peakMemory, resourcesDetails, resourcesText } from '../resources';
import { previousResourcesText } from '../../components/AttemptTag';

const resources = {
  version: 1, updated_at: '2026-11-20T10:00:00Z', interval_s: 5, samples: 120,
  host: { name: 'node-12', cpus: 64, memory_mb: 515000 },
  memory: { peak_mb: 6963, mean_mb: 3000, max_process_mb: 6900, cgroup_peak_mb: 8000, cgroup_limit_mb: 8192 },
  cpu: { mean_cores: 0.98, peak_cores: 1.02, time_s: 590 },
  gpus: [{ index: 0, uuid: 'GPU-aaa', name: 'NVIDIA A100', utilization_mean: 87.4, memory_peak_mb: 30000, run_memory_peak_mb: 21800, memory_total_mb: 40960, power_mean_w: 250, temperature_peak_c: 71 }],
};

test('sizes', () => {
  expect(memoryText(512.4)).toBe('512 MiB');
  expect(memoryText(6963)).toBe('6.8 GiB');
  expect(memoryText(40960)).toBe('40 GiB');
  expect(memoryText(undefined)).toBe(null);
  expect(memoryText(NaN)).toBe(null);
});

test('the peak memory: the processes, else the cgroup, with the files cache', () => {
  expect(peakMemory(resources)).toBe(6963);
  expect(peakMemory({ memory: { max_process_mb: 7000, peak_mb: 6963 } })).toBe(7000);
  expect(peakMemory({ memory: { cgroup_peak_mb: 8000 } })).toBe(8000);
  expect(peakMemory({})).toBe(null);
  expect(peakMemory(null)).toBe(null);
});

test('one line', () => {
  expect(resourcesText({ data: { resources } })).toBe('6.8 GiB peak memory · 1.0 core · GPU 0: 87% · 21 GiB / 40 GiB');
  expect(gpuText({ index: 1, memory_peak_mb: 512 })).toBe('GPU 1: 512 MiB');
  expect(gpuText({ index: 1 })).toBe('GPU 1');
  expect(resourcesText({ data: { resources: { cpu: { mean_cores: 3.5 } } } })).toBe('3.5 cores');
  // runs that didn't say
  expect(resourcesText({ data: {} })).toBe(null);
  expect(resourcesText({ data: { resources: [] } })).toBe(null);
  expect(resourcesText({ data: { resources: { version: 1 } } })).toBe(null);
  expect(resourcesText(undefined)).toBe(null);
});

test('details', () => {
  const details = resourcesDetails({ data: { resources } });
  expect(details).toContain('sampled every 5s: 6.8 GiB');
  expect(details).toContain('Peak memory of its cgroup, with the files\' cache: 7.8 GiB (limit: 8.0 GiB)');
  expect(details).toContain('GPU 0: 87% · 21 GiB / 40 GiB (NVIDIA A100), 250 W, up to 71°C');
  expect(details).toContain('On node-12 (64 CPUs, 503 GiB)');
  expect(details).toContain('Last measured: 2026-11-20T10:00:00Z');
  expect(resourcesDetails({ data: {} })).toBe(null);
  // what a job's cgroup says
  const killed = { ...resources, host: { ...resources.host, allocated_cpus: 8 }, memory: { ...resources.memory, cgroup_working_set_peak_mb: 7000, oom_kills: 2 } };
  expect(resourcesDetails({ data: { resources: killed } })).toContain('On node-12 (8 of 64 CPUs, 503 GiB)');
  expect(resourcesDetails({ data: { resources: killed } })).toContain('the kernel killed 2 of its processes');
  expect(resourcesText({ data: { resources: killed } })).toMatch(/· out of memory$/);
  // the memory of all its processes, when we don't know the run's own
  expect(resourcesDetails({ data: { resources: { gpus: [{ index: 0, memory_peak_mb: 512 }] } } })).toContain('GPU 0: 512 MiB, the memory of all its processes');
});

test('earlier attempts keep their peaks', () => {
  expect(previousResourcesText({ peak_mb: 4000, max_process_mb: 4090, cgroup_peak_mb: 4096, cgroup_limit_mb: 4096, gpu_memory_peak_mb: 12000 }))
    .toBe('4.0 GiB peak memory (limit 4.0 GiB) · 12 GiB GPU memory');
  expect(previousResourcesText({ host: 'node-12' })).toBe(null);
  expect(previousResourcesText(undefined)).toBe(null);
});
