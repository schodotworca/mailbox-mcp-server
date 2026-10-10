import { readFile } from "node:fs/promises";

type ReadText = (path: string) => Promise<string>;
const readText: ReadText = path => readFile(path, {encoding:"utf8", signal:AbortSignal.timeout(1000)});

/** Linux VM totals include the tunnel process; cgroup totals describe its resource limit. */
export async function readSystemMemory(read: ReadText = readText): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  const safeRead = async (path: string) => { try { return await read(path); } catch { return ""; } };
  const [info, current, limit] = await Promise.all([
    safeRead("/proc/meminfo"), safeRead("/sys/fs/cgroup/memory.current"), safeRead("/sys/fs/cgroup/memory.max"),
  ]);
  const total = /^MemTotal:\s+(\d+) kB$/m.exec(info);
  const available = /^MemAvailable:\s+(\d+) kB$/m.exec(info);
  if (total && available) {
    const totalBytes = Number(total[1]) * 1024;
    const availableBytes = Number(available[1]) * 1024;
    if (totalBytes > 0 && availableBytes >= 0 && availableBytes <= totalBytes) {
      result.machineTotalBytes = totalBytes;
      result.machineAvailableBytes = availableBytes;
      result.machineUsedBytes = totalBytes - availableBytes;
    }
  }
  let usageText = current, limitText = limit;
  if (!usageText.trim()) {
    [usageText, limitText] = await Promise.all([
      safeRead("/sys/fs/cgroup/memory/memory.usage_in_bytes"),
      safeRead("/sys/fs/cgroup/memory/memory.limit_in_bytes"),
    ]);
  }
  const numeric = (value: string) => /^\d+$/.test(value.trim()) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
  const usedBytes = numeric(usageText), limitBytes = numeric(limitText);
  if (usedBytes !== undefined) result.cgroupUsedBytes = usedBytes;
  // v1 uses an enormous integer and v2 uses "max" for no effective limit.
  if (limitBytes !== undefined && limitBytes > 0 && limitBytes < 2 ** 60) result.cgroupLimitBytes = limitBytes;
  return result;
}
