"""Demand-driven, bounded hardware snapshots. No import-time worker or CUDA calls."""
import atexit
import logging
import math
import threading
import time
import psutil

LOG = logging.getLogger('Magik Ressources Monitor')
MIN_INTERVAL = 0.25


def validate_query(query):
    try:
        interval = float(query.get('interval', 1))
    except (ValueError, TypeError):
        raise ValueError('interval must be a finite number')
    if not math.isfinite(interval) or not MIN_INTERVAL <= interval <= 60:
        raise ValueError('interval must be between 0.25 and 60 seconds')
    disk = query.get('disk', '')
    if not isinstance(disk, str) or len(disk) > 4096:
        raise ValueError('invalid disk mount')
    return interval, disk


class Sampler:
    def __init__(self, nvml=None, clock=time.monotonic):
        self.lock = threading.Lock()
        self.clock = clock
        self.nvml = nvml
        self.ready = False
        self.closed = False
        self.next_init = 0
        self.handles = []
        self.cache = None
        self.cache_time = -float('inf')
        self.disks = {}
        self.disk_lock = threading.Lock()
        self.disk_values = {}
        self.disk_busy = False
        self.retry = {}
        self.previous_cpu = None

    def _init_gpu(self):
        if self.ready or self.clock() < self.next_init:
            return
        self.next_init = self.clock() + 10
        initialized = False
        try:
            if self.nvml is None:
                import pynvml
                self.nvml = pynvml
            self.nvml.nvmlInit()
            initialized = True
            handles = []
            for i in range(self.nvml.nvmlDeviceGetCount()):
                try:
                    h = self.nvml.nvmlDeviceGetHandleByIndex(i)
                    name = self.nvml.nvmlDeviceGetName(h)
                    if isinstance(name, bytes):
                        name = name.decode('utf-8', errors='replace')
                    handles.append((i, h, str(name)))
                except Exception as exc:
                    LOG.warning('GPU %s discovery failed: %s', i, exc)
            self.handles = handles
            self.ready = True
        except Exception as exc:
            LOG.warning('NVIDIA monitoring unavailable; retrying in 10s: %s', exc)
            if initialized:
                try:
                    self.nvml.nvmlShutdown()
                except Exception:
                    pass

    def _read(self, key, fn, errors):
        if self.clock() < self.retry.get(key, 0):
            errors[key] = 'Temporarily unavailable; retry pending'
            return None
        try:
            result = fn()
            self.retry.pop(key, None)
            return result
        except Exception as exc:
            self.retry[key] = self.clock() + 5
            errors[key] = str(exc)
            LOG.warning('%s unavailable; retrying in 5s: %s', key, exc)
            return None

    def _cpu(self):
        # Keep our own baseline: asyncio.to_thread may use a different OS thread
        # for every request, while psutil.cpu_percent baselines are thread-local.
        sample = psutil.cpu_times()
        fields = sample._asdict()
        total = sum(fields.values()) - fields.get('guest', 0) - fields.get('guest_nice', 0)
        idle = fields.get('idle', 0) + fields.get('iowait', 0)
        previous = self.previous_cpu
        self.previous_cpu = (total, idle)
        if previous is None:
            return None
        delta = total - previous[0]
        return max(0, min(100, (1 - (idle - previous[1]) / delta) * 100)) if delta > 0 else None

    def snapshot(self, disk=''):
        with self.lock:
            if self.closed:
                raise RuntimeError('Monitor has shut down')
            now = self.clock()
            # Mount validation and disk capacity have a separate slow cache.
            if now >= self.disks.get('expires', 0):
                mounts = sorted(set(p.mountpoint for p in psutil.disk_partitions()))
                self.disks = {'expires': now + 15, 'mounts': mounts, 'values': {}}
            if disk and disk not in self.disks['mounts']:
                raise ValueError('disk must be one of the available mount points')
            if self.cache is None or now - self.cache_time >= MIN_INTERVAL:
                errors = {}
                cpu = self._read('cpu', self._cpu, errors)
                ram = self._read('ram', psutil.virtual_memory, errors)
                self._init_gpu()
                gpus = []
                for index, handle, name in self.handles:
                    prefix = f'gpu{index}'
                    util = self._read(prefix + '.utilization', lambda: self.nvml.nvmlDeviceGetUtilizationRates(handle).gpu, errors)
                    mem = self._read(prefix + '.memory', lambda: self.nvml.nvmlDeviceGetMemoryInfo(handle), errors)
                    temp = self._read(prefix + '.temperature', lambda: self.nvml.nvmlDeviceGetTemperature(handle, self.nvml.NVML_TEMPERATURE_GPU), errors)
                    gpus.append({'index': index, 'name': name, 'utilization': util,
                                 'temperature': temp, 'used': mem.used if mem else None,
                                 'total': mem.total if mem else None,
                                 'percent': mem.used / mem.total * 100 if mem and mem.total else None})
                self.cache = {'timestamp': time.time(), 'cpu': cpu,
                              'ram': {'used': ram.total - ram.available, 'total': ram.total, 'percent': ram.percent} if ram else None,
                              'gpus': gpus, 'errors': errors, 'gpu_available': self.ready and bool(self.handles)}
                self.cache_time = now
            result = {**self.cache, 'errors': dict(self.cache['errors']), 'mounts': self.disks['mounts'], 'disk': None}
            if disk:
                with self.disk_lock:
                    cached = self.disk_values.get(disk)
                    if cached and now - cached[0] < 15:
                        result['disk'] = cached[1]
                    elif not self.disk_busy:
                        self.disk_busy = True
                        threading.Thread(target=self._disk_sample, args=(disk,), daemon=True,
                                         name='MagikResourcesDisk').start()
                    if result['disk'] is None:
                        result['errors']['disk'] = 'Capacity unavailable or being refreshed'
            return result

    def _disk_sample(self, disk):
        # A slow/network mount must never hold up CPU/GPU sampling or shutdown.
        value = None
        try:
            d = psutil.disk_usage(disk)
            value = {'used': d.used, 'total': d.total, 'percent': d.percent}
        except Exception as exc:
            LOG.warning('Disk capacity unavailable for %s: %s', disk, exc)
        finally:
            with self.disk_lock:
                self.disk_values[disk] = (self.clock(), value)
                self.disk_busy = False


    def close(self):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            if self.ready:
                try:
                    self.nvml.nvmlShutdown()
                except Exception:
                    pass
                self.ready = False


sampler = Sampler()
atexit.register(sampler.close)
