import importlib.util
from pathlib import Path
import threading
from collections import namedtuple
import unittest
from types import SimpleNamespace as NS
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('monitor_under_test', Path(__file__).parents[1] / 'monitor.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class NVML:
    NVML_TEMPERATURE_GPU = 0
    def __init__(self): self.calls=0; self.shutdowns=0; self.fail=True
    def nvmlInit(self): pass
    def nvmlShutdown(self): self.shutdowns+=1
    def nvmlDeviceGetCount(self): return 2
    def nvmlDeviceGetHandleByIndex(self,i): return i
    def nvmlDeviceGetName(self,h): return f'GPU {h}'.encode()
    def nvmlDeviceGetUtilizationRates(self,h):
        self.calls+=1
        if h==0 and self.fail: raise RuntimeError('temporary driver error')
        return NS(gpu=42)
    def nvmlDeviceGetMemoryInfo(self,h): return NS(used=10,total=100)
    def nvmlDeviceGetTemperature(self,h,t): return 60

class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.time=100
        self.nv=NVML();self.s=m.Sampler(self.nv,lambda:self.time)
        self.patches=[patch.object(m.psutil,'disk_partitions',return_value=[NS(mountpoint='/')]),
                      patch.object(m.psutil,'virtual_memory',return_value=NS(total=100,available=40,used=50,percent=60)),
                      patch.object(m.psutil,'cpu_times',side_effect=lambda: namedtuple('CPU','user idle')(self.time*.2,self.time*.8)),
                      patch.object(m.psutil,'disk_usage',return_value=NS(used=50,total=100,percent=50))]
        for p in self.patches:p.start()
    def tearDown(self):
        self.s.close()
        for p in self.patches:p.stop()
    def test_sensor_isolation_retry_and_cache(self):
        d=self.s.snapshot()
        self.assertIsNone(d['gpus'][0]['utilization'])
        self.assertEqual(d['gpus'][1]['utilization'],42)
        self.assertEqual(d['gpus'][0]['temperature'],60)
        self.assertEqual(d['ram']['used'],60)
        self.s.snapshot();self.assertEqual(self.nv.calls,2)
        self.time+=1;self.s.snapshot();self.assertEqual(self.nv.calls,3)
        self.nv.fail=False;self.time+=5
        self.assertEqual(self.s.snapshot()['gpus'][0]['utilization'],42)
    def test_bad_mount_does_not_damage_future_requests(self):
        with self.assertRaises(ValueError):self.s.snapshot('/missing')
        self.assertEqual(self.s.snapshot()['ram']['percent'],60)
    def test_instance_isolation(self):
        other=m.Sampler(NVML(),lambda:self.time)
        self.assertIsNot(other.handles,self.s.handles)
        self.assertIsNot(other.lock,self.s.lock)
        other.close();self.assertFalse(self.s.closed)
    def test_shutdown_idempotent(self):
        self.s.snapshot();self.s.close();self.s.close()
        self.assertEqual(self.nv.shutdowns,1)
    def test_slow_disk_does_not_block_cpu_gpu(self):
        entered = threading.Event()
        release = threading.Event()
        def slow_disk(_):
            entered.set()
            release.wait(2)
            return NS(used=50,total=100,percent=50)
        with patch.object(m.psutil, 'disk_usage', side_effect=slow_disk):
            first = self.s.snapshot('/')
            self.assertIsNone(first['disk'])
            self.assertTrue(entered.wait(1))
            try:
                self.time += 1
                self.assertEqual(self.s.snapshot()['gpus'][1]['utilization'],42)
            finally:
                release.set()

    def test_validation(self):
        for value in ['nan','inf','-1','0','.01','61','oops']:
            with self.assertRaises(ValueError):m.validate_query({'interval':value})
        self.assertEqual(m.validate_query({'interval':'.25'}),(.25,''))
    def test_concurrent_clients_share_cache(self):
        threads=[threading.Thread(target=self.s.snapshot) for _ in range(10)]
        for t in threads:t.start()
        for t in threads:t.join()
        self.assertEqual(self.nv.calls,2)
    def test_cpu_failure_recovers(self):
        self.s.snapshot()
        self.time+=1
        with patch.object(m.psutil,'cpu_times',side_effect=RuntimeError('temporary')):
            self.assertIsNone(self.s.snapshot()['cpu'])
        self.time+=6
        self.assertAlmostEqual(self.s.snapshot()['cpu'],20)

if __name__=='__main__':unittest.main()
