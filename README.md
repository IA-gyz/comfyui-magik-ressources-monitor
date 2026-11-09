# Magik Ressources Monitor — 1.0.0

Lightweight CPU, RAM, NVIDIA utilization, VRAM, GPU temperature and filesystem-capacity monitoring for ComfyUI. No workflow nodes are added.

## Install

1. Extract `Magik_Ressources_Monitor` into `ComfyUI/custom_nodes/`.
2. In your ComfyUI Python environment run `python -m pip install -r custom_nodes/Magik_Ressources_Monitor/requirements.txt`.
3. Restart ComfyUI and refresh the browser.
4. Open Settings → Magik Ressources Monitor.

Disable/remove the old Crystools MonitorOnly extension if you want to replace its display. The new extension uses its own settings and endpoints; old preferences are not imported.

## Controls

- The monitor defaults to a movable floating panel. Drag its header; its position is saved in the browser. Top/Bottom placement uses the existing menu container, following the menu's location. Legacy placement uses the old queue menu. If a target is unavailable the panel floats.
- Toggle individual measurements, or individual GPU sensors in Settings.
- Refresh is **seconds between updates**: `0.25` means four times per second, `2` means once every two seconds. `0` pauses. The backend accepts intervals of 0.25–60 seconds; pause is handled locally without requests.
- Hidden tabs stop polling. Each tab has independent settings; no global settings are mutated by a browser.
- Width, height, animation and numbers-only settings apply to every placement mode.
- Enable filesystem capacity and choose a mount in the panel's selector. Disk capacity is refreshed approximately every 15 seconds on demand. An unavailable/slow mount does not block CPU/GPU sampling.
- Hover readings for exact used/total memory and observed peaks. Reset peaks clears only this browser session. Peaks are independent for RAM, every GPU and every disk. They represent sampled peaks, not every transient allocation.

## Reliability and design

Hardware snapshots are demand-driven, cached for at least 250 ms and serialized across clients. There is no permanently running polling worker, websocket broadcast, global start/stop event, or CUDA/PyTorch dependency. CPU deltas use a sampler-owned baseline across request threads. The first CPU reading is unavailable while that baseline is established.

NVIDIA discovery retries after 10 seconds if initialization fails. Individual sensor failures retry after 5 seconds without disabling other devices or measurements. Missing values display an em dash, failed connections invalidate readings, and paused/stale states are explicit. API settings are read-only query parameters with finite interval and mount validation. No arbitrary GPU indexing endpoint is exposed.

NVML initialization is lazy. Shutdown is idempotent and registered with `atexit`. Disk sampling uses at most one short-lived daemon worker at a time; a system call stuck in the OS cannot be cancelled by Python, but it cannot block CPU/GPU reads or process exit. CPU/GPU requests run outside the ComfyUI event loop. Hardware libraries themselves can still block inside driver/system calls; browser requests time out after five seconds.

## Interpretation

CPU is a whole-system average. RAM used is total minus available so it agrees with the displayed pressure percentage, including Linux cache semantics. GPU/VRAM are device-wide, not ComfyUI-only or PyTorch allocator statistics. Disk means occupied filesystem capacity, not activity, throughput or latency. This tool does not log history or diagnose microfreezes.

## Validation

Run `python -m unittest discover -s tests -v` from this folder. Tests use fake NVIDIA sensors and controlled system readings to verify recovery, device isolation, request validation, cache sharing, independent instances and shutdown. Run `node tests/test_frontend.cjs` for independent peak tracking, unavailable-state and recovery checks. JavaScript syntax can be checked with `node --check web/monitor.js`.

Full integration with a real ComfyUI server and NVIDIA driver must be verified on the target system.

## Attribution

Based on the monitoring scope and interface of ComfyUI-Crystools-MonitorOnly by BobRandomNumber, derived from ComfyUI-Crystools by Crystian. Backend and frontend refactored for Magik Ressources Monitor. The original MIT license and copyright notice are preserved in LICENSE.
