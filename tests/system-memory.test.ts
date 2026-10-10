import {describe,it,expect} from "vitest";
import {readSystemMemory} from "../src/utils/systemMemory.js";
const reader = (files: Record<string,string>) => async (path: string) => {if (!(path in files)) throw new Error('missing'); return files[path];};
describe('Linux memory metrics', () => {
  it('includes VM totals and finite cgroup v2 usage separately', async () => {
    expect(await readSystemMemory(reader({'/proc/meminfo':'MemTotal: 262144 kB\nMemAvailable: 32768 kB\n',
      '/sys/fs/cgroup/memory.current':'200000000\n','/sys/fs/cgroup/memory.max':'268435456\n'})))
      .toEqual({machineTotalBytes:268435456,machineAvailableBytes:33554432,machineUsedBytes:234881024,cgroupUsedBytes:200000000,cgroupLimitBytes:268435456});
  });
  it('handles cgroup v1 and ignores unlimited or malformed limits', async () => {
    expect(await readSystemMemory(reader({'/sys/fs/cgroup/memory/memory.usage_in_bytes':'1024','/sys/fs/cgroup/memory/memory.limit_in_bytes':'9223372036854771712'})))
      .toEqual({cgroupUsedBytes:1024});
    expect(await readSystemMemory(reader({'/sys/fs/cgroup/memory.current':'2048','/sys/fs/cgroup/memory.max':'max'}))).toEqual({cgroupUsedBytes:2048});
    expect(await readSystemMemory(reader({}))).toEqual({});
  });
});
