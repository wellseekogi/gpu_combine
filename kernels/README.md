# TileLang residual + RMS kernels

The active implementation is [`residual_rms_f32.py`](residual_rms_f32.py).
All five CUDA entry points have TileLang equivalents: configurable fused
`residual_rms_f32`, the fixed-512 `residual_rms_f32_small`, the scalar-1024
`baseline_residual_rms_f32`, and separate `reference_add_f32` / `reference_rms_f32`.
They remain standalone experimental kernels, outside the provider/llama.cpp graph.
The original `.cu` file and checker below are retained for historical comparison.

The port uses `T.ieee_add` for separately rounded FP32 residual sums, explicit
scalar/4-element fragment layouts, and `T.reduce_sum` for RMS normalization.
Both sum and weighted normalization are written into caller-provided buffers.
FMA, flush-to-zero, and fast math are disabled. Reduction order can differ from
CUDA: require bitwise residual sums and the same `2e-6 + 2e-6 * abs(cpu_double)`
normalization tolerance, not bitwise normalization equality.

The shape, epsilon, alignment, and nonoverlap contract below also applies to
TileLang. Factories validate shape/geometry; callers must validate the buffers
and finite positive FP32 epsilon before launching, as the checker does.
The default 512 threads for 1..16 rows / 128 otherwise is inherited from CUDA
calibration and **has not been established as optimal for TileLang**. `--threads`
and `--scalar` remain available for device-specific calibration.

## Run the TileLang port

Use Python with CUDA-enabled PyTorch, TileLang, NVIDIA CUDA headers/toolchain,
and `cuda-python` for TileLang's NVRTC execution backend. Native Windows x86-64
is supported by current TileLang; Linux/WSL also works. Install into an isolated
environment, following the [official TileLang installation guide](https://tilelang.com/get_started/Installation.html)
and [PyTorch selector](https://pytorch.org/get-started/locally/) for your driver.
The production provider does not need these development dependencies.

Reproduce the Windows development environment used for this port (Python 3.13,
driver 592.27, RTX 3050 Ti; all dependencies stay under `work/`):

```powershell
python -m venv work/tilelang-migration/venv
work/tilelang-migration/venv/Scripts/python -m pip install torch==2.9.1 --index-url https://download.pytorch.org/whl/cu130
work/tilelang-migration/venv/Scripts/python -m pip install -r kernels/requirements-tilelang.txt
$env:TILELANG_CACHE_DIR = "$PWD/work/tilelang-migration/cache"
$env:TVM_FFI_CACHE_DIR = "$PWD/work/tilelang-migration/tvm-ffi-cache"
work/tilelang-migration/venv/Scripts/python scripts/check-tilelang-kernel.py --repeats 0
```

The following commands assume that environment's Python is active:

```sh
python scripts/check-tilelang-kernel.py --self-check
python scripts/check-tilelang-kernel.py --repeats 0 --rows 1 16 17 33 128 257 1024 --output work/tilelang-result.json
python scripts/check-tilelang-kernel.py --threads 128 --repeats 200 --samples 15
```

The checker reuses the CUDA checker's seeded input patterns and CPU-double oracle,
checks both outputs and aligned guard regions, and optionally times CUDA graph
replays. Missing dependencies/compiler/GPU and failed comparisons exit nonzero;
the dependency-free `--self-check` validates contracts only, not GPU correctness.
Its baseline is another TileLang configuration, not the old compiled CUDA kernel
or llama.cpp. Historical CUDA timings below do not describe this port's speed.

Caller example (all five tensors must be separate contiguous CUDA float32 buffers):

```python
import torch
from kernels.residual_rms_f32 import residual_rms_f32

kernel = residual_rms_f32(rows=33, threads=128)
kernel(x, residual, weight, sum_out, output, 1e-6,
       stream=torch.cuda.current_stream(x.device).cuda_stream)
```

Always pass the current CUDA stream explicitly, including to the reference
kernels. TileLang 0.1.15's NVRTC adapter can fall back to stream 0 when its target
is represented as JSON, racing work submitted to a nondefault PyTorch stream.
Factories cache compiled kernels by geometry; compile before graph capture.
`reference_add_f32(count)` accepts flattened tensors and masks its final block.
The remaining factories accept `[rows, 4096]` matrices and `[4096]` weights.
DSL references: [IEEE math](https://tilelang.com/autoapi/tilelang/language/math_intrinsics/index.html),
[fragment layouts](https://tilelang.com/autoapi/tilelang/layout/fragment/index.html),
and [official RMSNorm example](https://github.com/tile-ai/tilelang/blob/main/examples/norm/rms_norm.py).

## Port validation (2026-09-30)

On the RTX 3050 Ti, TileLang 0.1.15 / PyTorch 2.9.1+cu130 passed 12 input cases
through 1024 rows, plus the 257-element ADD tail. Residual sums matched bitwise;
maximum fused normalized error was `9.88e-7`, within the original tolerance.
All six thread counts (32..1024) passed in scalar and vectorized modes. Additional
checks passed at epsilon `2**-149` and `3e38`. Graph capture/replay matched direct
results for every variant at 1 and 17 rows. Generated source contains `__fadd_rn`
and float4 loads/stores for the vectorized path.

The unchanged CUDA kernels also passed seven cases after extracting the shared
oracle helpers. These checks establish local numerical correctness, not a
speedup over CUDA or an integrated model benchmark. Other GPUs remain untested.

## Original CUDA reference and historical measurements

`residual-rms-f32.cu` is a standalone CUDA candidate, **not enabled in the provider or llama.cpp graph**. It combines `sum = F32(x + residual)` and `output = RMSNorm(sum) * weight` while preserving the sum as a separate output for its later graph consumers. It does not change Q8_0 model weights or f16 KV caches.

Contract: contiguous F32 matrices with exactly 4096 columns, one shared F32 weight vector of length 4096, five nonoverlapping device buffers aligned to at least 16 bytes, finite positive F32 epsilon, and one block per row. Launch `residual_rms_f32` with exactly `RMS_THREADS` threads (default **128**) or `residual_rms_f32_small` with exactly **512** threads; the original/reference kernels still require 1024. The checker chooses the small entry for 1..16 rows, otherwise the 128-thread entry. An explicit `--threads` overrides this measured, conservative split. The check bounds rows to 1..1024 and validates the launch contract before using the GPU. Wider shapes, strides, buffer aliasing, non-finite inputs, overflowing square sums, and arbitrary model graphs remain outside this prototype. Fused multiply-add, flush-to-zero and fast math are disabled; weights/KV precision is unchanged.

The candidate uses aligned `float4` loads/stores, keeps the residual values in registers, and reduces through four warps and 16 shared bytes in the 128-thread path (16 warps and 64 shared bytes in the 512-thread path). Both entry points share the same templated arithmetic. The original scalar 1024-thread fused kernel and its two-launch ADD then RMS×weight reference are retained unchanged as local comparisons. Neither is the compiled llama.cpp baseline. Each implementation must match the F32-rounded residual sum bitwise and satisfy `abs_error <= 2e-6 + 2e-6 * abs(cpu_double)` for every normalized value. The candidate's different F32 reduction order is **not bitwise identical** to the old normalization. The original fused/reference pair must still match bitwise.

## Run on either test PC

Requires 64-bit Windows Python, an NVIDIA driver, and the two NVIDIA NVRTC DLLs. No Python packages or system-wide CUDA installation are required. A missing compiler/GPU or failed comparison exits nonzero; CPU fallback is never reported as a pass.

If CUDA NVRTC 12.4 is installed, point `--nvrtc` at its `nvrtc64_120_0.dll` with `nvrtc-builtins64_124.dll` beside it. Otherwise obtain the official NVIDIA wheel without installing it (run from the repository root):

```powershell
New-Item -ItemType Directory -Force work/kernel-development/nvrtc
Invoke-WebRequest 'https://files.pythonhosted.org/packages/7c/30/8c844bfb770f045bcd8b2c83455c5afb45983e1a8abf0c4e5297b481b6a5/nvidia_cuda_nvrtc_cu12-12.4.127-py3-none-win_amd64.whl' -OutFile work/kernel-development/nvrtc/nvidia_cuda_nvrtc_cu12-12.4.127-py3-none-win_amd64.whl
if ((Get-FileHash work/kernel-development/nvrtc/nvidia_cuda_nvrtc_cu12-12.4.127-py3-none-win_amd64.whl -Algorithm SHA256).Hash -ne 'a961b2f1d5f17b14867c619ceb99ef6fcec12e46612711bcec78eb05068a60ec') { throw 'NVRTC wheel hash mismatch' }
python -m zipfile -e work/kernel-development/nvrtc/nvidia_cuda_nvrtc_cu12-12.4.127-py3-none-win_amd64.whl work/kernel-development/nvrtc
python scripts/check-cuda-kernel.py --nvrtc work/kernel-development/nvrtc/nvidia/cuda_nvrtc/bin/nvrtc64_120_0.dll --output work/kernel-development/cuda-kernel-result.json
```

The dependency stays in the ignored work directory. Its NVIDIA license is included in the wheel; it is not bundled with this source. Package provenance and SHA256: [NVIDIA package metadata](https://pypi.org/pypi/nvidia-cuda-nvrtc-cu12/12.4.127/json). Compilation interface: [NVIDIA NVRTC documentation](https://docs.nvidia.com/cuda/nvrtc/index.html).

`--device 0` selects a GPU; `--repeats 0` disables timing; `--eps 1e-6` sets epsilon. `--rows 1 33 128 257`, `--repeats 200 --samples 15`, and `--threads 128` reproduce the recorded run. `--threads 32|64|128|256|512|1024` and `--scalar` expose calibration choices; the explicit thread option disables the default 1..16-row split. A future host launcher must use the same geometry as the compilation. Only compute capabilities 7.5 and 8.6 are accepted. Both PTX targets compile on each run; only the installed target executes. Compiling for 7.5 does not verify execution on a 1660 SUPER.

`python scripts/check-cuda-kernel.py --self-check` checks invalid dimensions, epsilon, alignment and overlapping buffers without a GPU. The GPU check uses poisoned outputs and aligned guard regions, verifies graph node counts, and checks the final graph replay against its validated direct launch.

## Scope of the local result

The [round-2 report](../docs/reports/kernel-round2-2026-09-29-ko.md) compares against this round-1 128-thread baseline. At 1/8/16 rows, the small entry reduced same-run medians by 8.81%/6.90%/9.53%. Larger rows retain 128 threads. Round 2 observed a 20 W power limit and 810 MHz memory clock, unlike round 1; absolute timings across these power envelopes must not be compared. Row packing, rereading sums, and cache-policy alternatives were explored but not adopted. The following timing summary is the historical **round-1 fixed-128-thread** result.

The 2026-09-29 RTX 3050 Ti run passed nine seeded cases, including cancellation, tiny values, large dynamic range and F32 rounding ties. Extra checks cover row boundaries through 1024 and epsilon from the smallest F32 subnormal to `3e38`. The default candidate uses 56 registers/thread, 16 shared bytes/block and **zero local-memory spill bytes** according to the loaded driver's function attributes. Max observed normalized error in the default suite was `9.88e-7`.

Timing now captures 200 calls plus two external timing-event nodes in a CUDA graph, warms each variant for at least 150 ms, then replays it 15 times in seeded shuffled order. GPU timestamps exclude Python launch gaps. Median candidate times were **2.125 / 6.984 / 45.967 / 93.377 µs** for 1 / 33 / 128 / 257 rows, reducing time by **6.10% / 16.01% / 5.59% / 2.60%** against the unchanged original fused kernel in the same run. These are warm synthetic buffers with unlocked laptop clocks, including graph scheduling; small differences require recalibration on the actual device.

The check reuses output buffers between sequential comparisons: at 257 rows explicit device allocation fell from 25,280,512 to **16,860,160 bytes (16.08 MiB, including 1 KiB guards)**. This is a **test-harness** allocation saving, not model VRAM savings. The fused operation still retains both necessary outputs and has the same five-buffer footprint as the original fused operation. Driver context/JIT/graph overhead is additional and not included in this count. The owned context is destroyed on completion.

Raw samples, hashes and calibration variants are in [the evidence JSON](../docs/research/kernel-performance-20260929.json); interpretation and constraints are in [the Korean report](../docs/reports/kernel-performance-2026-09-29-ko.md). Before enabling this candidate in llama.cpp: validate actual graph lifetimes and alignment, compare against the pinned compiled backend and full-model logits, test compute 7.5 hardware, and measure end-to-end prefill/decode. No two-PC or kernel-integrated full-model speedup has been measured. Round 2 separately benchmarks an existing local Qwen3-4B Q3_K_M model with the unmodified pinned runtime; it does not replace the Q8_0 production contract.

Primary API references, pinned to CUDA 12.4.1: [graph management](https://docs.nvidia.com/cuda/archive/12.4.1/cuda-driver-api/group__CUDA__GRAPH.html), [external event capture](https://docs.nvidia.com/cuda/archive/12.4.1/cuda-driver-api/group__CUDA__EVENT.html), and [vector alignment and warp shuffle rules](https://docs.nvidia.com/cuda/archive/12.4.1/cuda-c-programming-guide/index.html).
