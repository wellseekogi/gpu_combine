"""Windows NVIDIA kernel check + graph replay benchmark; stdlib, no install.

Requires explicitly supplied NVRTC DLL. Never modifies production inference.
Missing GPU/compiler and any correctness failure exit nonzero.
"""
import argparse
import array
import ctypes as C
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import random
import statistics
import sys
import time

WIDTH, BASELINE_THREADS, GUARD_WORDS = 4096, 1024, 64
VOID, U64, SIZE = C.c_void_p, C.c_uint64, C.c_size_t


def checked(lib, name, *args):
    code = getattr(lib, name)(*args)
    if code:
        raise RuntimeError(f"{name} failed with status {code}")


def compile_ptx(nvrtc, source, arch, threads=128, vectorize=True):
    program = VOID()
    checked(nvrtc, "nvrtcCreateProgram", C.byref(program), source,
            b"residual-rms-f32.cu", 0, None, None)
    try:
        options = [f"--gpu-architecture=compute_{arch}".encode(), b"--std=c++14",
                   b"--fmad=false", b"--ftz=false", b"--prec-div=true", b"--prec-sqrt=true",
                   f"-DRMS_THREADS={threads}".encode(), f"-DRMS_VECTORIZE={int(vectorize)}".encode()]
        status = nvrtc.nvrtcCompileProgram(program, len(options),
                                          (C.c_char_p * len(options))(*options))
        size = SIZE()
        checked(nvrtc, "nvrtcGetProgramLogSize", program, C.byref(size))
        log = C.create_string_buffer(size.value)
        checked(nvrtc, "nvrtcGetProgramLog", program, log)
        if status:
            raise RuntimeError(f"NVRTC compute_{arch}: {log.value.decode(errors='replace')}")
        checked(nvrtc, "nvrtcGetPTXSize", program, C.byref(size))
        ptx = C.create_string_buffer(size.value)
        checked(nvrtc, "nvrtcGetPTX", program, ptx)
        return ptx.raw
    finally:
        checked(nvrtc, "nvrtcDestroyProgram", C.byref(program))


def host(values):
    data = array.array("f", values)
    return (C.c_float * len(data)).from_buffer_copy(data)


def launch(driver, function, blocks, threads, args, stream):
    pointers = (VOID * len(args))(*(C.cast(C.byref(arg), VOID) for arg in args))
    checked(driver, "cuLaunchKernel", function, blocks, 1, 1, threads, 1, 1,
            0, stream, pointers, None)


def select_threads(rows, override=None):
    """Conservative measured split; explicit calibration always takes precedence."""
    return override if override is not None else (512 if rows <= 16 else 128)


def validate_case(rows, width, eps, threads, pointers=()):
    if type(rows) is not int or not 1 <= rows <= 1024 or width != WIDTH:
        raise ValueError("kernel check requires 1..1024 rows and exactly 4096 columns")
    if threads not in (32, 64, 128, 256, 512, 1024):
        raise ValueError("threads must be a power of two from 32 to 1024")
    eps_f32 = C.c_float(eps).value
    if not math.isfinite(eps_f32) or eps_f32 <= 0:
        raise ValueError("eps must round to a finite positive F32 value")
    if pointers:
        if len(pointers) != 5:
            raise ValueError("five buffers are required")
        spans = sorted((p, p + n * 4) for p, n in zip(pointers, (rows * width, rows * width,
                                                               width, rows * width, rows * width)))
        if any(p <= 0 or p % 16 for p in pointers) or any(a[1] > b[0] for a, b in zip(spans, spans[1:])):
            raise ValueError("buffers must be nonoverlapping and 16-byte aligned")
    return eps_f32


def graph_timings(driver, stream, operations, repeats, samples):
    """One captured chain per operation, timed inside graph event-record nodes."""
    graphs, executables, events, node_counts = [], {}, [], {}
    try:
        for _ in range(2):
            event = VOID()
            checked(driver, "cuEventCreate", C.byref(event), 0)
            events.append(event)
        for label, operation in operations.items():
            graph, executable = VOID(), VOID()
            checked(driver, "cuStreamBeginCapture_v2", stream, 0)
            try:
                # EXTERNAL records real event nodes in capture; timestamps are on
                # the GPU, with no Python submissions between the timed kernels.
                checked(driver, "cuEventRecordWithFlags", events[0], stream, 1)
                for _ in range(repeats):
                    operation()
                checked(driver, "cuEventRecordWithFlags", events[1], stream, 1)
            finally:
                checked(driver, "cuStreamEndCapture", stream, C.byref(graph))
                if graph:
                    graphs.append(graph)
            node_count = SIZE()
            checked(driver, "cuGraphGetNodes", graph, None, C.byref(node_count))
            expected_nodes = repeats * (2 if label == "two_launch_reference" else 1) + 2
            if node_count.value != expected_nodes:
                raise AssertionError(f"{label}: expected {expected_nodes} graph nodes, got {node_count.value}")
            node_counts[label] = node_count.value
            checked(driver, "cuGraphInstantiateWithFlags", C.byref(executable), graph, U64(0))
            executables[label] = executable
            # Let the laptop's normal clock ramp settle without changing clocks.
            warmup_until = time.perf_counter() + 0.15
            while time.perf_counter() < warmup_until:
                checked(driver, "cuGraphLaunch", executable, stream)
                checked(driver, "cuStreamSynchronize", stream)
        timings = {label: [] for label in operations}
        rng = random.Random(20260929)
        for _ in range(samples):
            order = list(operations)
            rng.shuffle(order)
            for label in order:
                checked(driver, "cuGraphLaunch", executables[label], stream)
                # Synchronize the stream, not a previous recording of a graph event.
                checked(driver, "cuStreamSynchronize", stream)
                elapsed = C.c_float()
                checked(driver, "cuEventElapsedTime", C.byref(elapsed), *events)
                timings[label].append(elapsed.value * 1000 / repeats)
        return timings, node_counts, order[-1]
    finally:
        for executable in executables.values():
            checked(driver, "cuGraphExecDestroy", executable)
        for graph in graphs:
            checked(driver, "cuGraphDestroy", graph)
        for event in events:
            checked(driver, "cuEventDestroy_v2", event)


def make_inputs(rows, pattern):
    """Deterministic F32 cases shared by CUDA and TileLang checks."""
    rng = random.Random(20260927 + rows)
    count = rows * WIDTH
    x = host(rng.uniform(-3, 3) for _ in range(count))
    residual = host(rng.uniform(-3, 3) for _ in range(count))
    weight = host(rng.uniform(-2, 2) for _ in range(WIDTH))
    if pattern == "zero":
        x, residual = host([0.0] * count), host([0.0] * count)
    elif pattern == "cancellation":
        residual = host(-value for value in x)
        for i in range(0, count, 17):
            residual[i] += 2 ** -20
    elif pattern == "small":
        x = host(value * 1e-8 for value in x)
        residual = host(value * 1e-8 for value in residual)
    elif pattern == "dynamic_range":
        x = host(((-1) ** i) * 10 ** ((i % 17) - 8) for i in range(count))
        residual = host(value * 0.25 for value in x)
    elif pattern == "rounding":
        x = host((2 ** 24) * (-1 if i % 2 else 1) for i in range(count))
        residual = host((-1, 1, 3, -3)[i % 4] for i in range(count))
    elif pattern != "random":
        raise ValueError(f"unknown input pattern: {pattern}")
    return x, residual, weight


def cpu_reference(x, residual, weight, eps):
    expected_sums = host(a + b for a, b in zip(x, residual))
    expected = array.array("d")
    for start in range(0, len(x), WIDTH):
        values = expected_sums[start:start + WIDTH]
        scale = 1.0 / math.sqrt(math.fsum(v * v for v in values) / WIDTH + eps)
        expected.extend(scale * v * w for v, w in zip(values, weight))
    return expected_sums, expected


def numerical_errors(output, expected, label):
    if len(output) != len(expected):
        raise AssertionError(f"{label}: output length differs")
    max_error, max_scaled = 0.0, 0.0
    for i, (actual, value) in enumerate(zip(output, expected)):
        error = abs(actual - value)
        tolerance = 2e-6 + 2e-6 * abs(value)
        if not math.isfinite(actual) or error > tolerance:
            raise AssertionError(f"{label}/{i}: {actual} != {value}")
        max_error = max(max_error, error)
        max_scaled = max(max_scaled, error / tolerance)
    return {"max_abs_error": max_error, "max_tolerance_fraction": max_scaled}


def run_case(driver, functions, stream, rows, pattern, eps, threads, repeats, samples):
    eps = validate_case(rows, WIDTH, eps, threads)
    x, residual, weight = make_inputs(rows, pattern)
    count = rows * WIDTH

    device = []
    try:
        # Output allocations are shared across sequential comparisons.
        for length in (count, count, WIDTH, count + 2 * GUARD_WORDS, count + 2 * GUARD_WORDS):
            pointer = U64()
            checked(driver, "cuMemAlloc_v2", C.byref(pointer), SIZE(length * 4))
            device.append(pointer)
        dx, dr, dw, ds_base, dy_base = device
        # 256-byte guards preserve allocation alignment for coalesced accesses
        # and catch out-of-grid writes without trusting allocator page padding.
        ds, dy = U64(ds_base.value + 4 * GUARD_WORDS), U64(dy_base.value + 4 * GUARD_WORDS)
        validate_case(rows, WIDTH, eps, threads, [p.value for p in (dx, dr, dw, ds, dy)])
        for destination, values in ((dx, x), (dr, residual), (dw, weight)):
            checked(driver, "cuMemcpyHtoD_v2", destination, values, SIZE(C.sizeof(values)))
        epsilon, size = C.c_float(eps), C.c_int(count)
        fused_args = [dx, dr, dw, ds, dy, epsilon]
        add_args = [dx, dr, ds, size]
        norm_args = [ds, dw, dy, epsilon]

        def fused():
            launch(driver, functions[0], rows, threads, fused_args, stream)

        def baseline():
            launch(driver, functions[1], rows, BASELINE_THREADS, fused_args, stream)

        def reference():
            launch(driver, functions[2], (count + 255) // 256, 256, add_args, stream)
            launch(driver, functions[3], rows, BASELINE_THREADS, norm_args, stream)

        expected_sums, expected = cpu_reference(x, residual, weight, eps)
        operations = {"fused": fused, "original_fused": baseline, "two_launch_reference": reference}
        results, errors = {}, {}
        sums_buffer, output_buffer = (C.c_float * (count + 2 * GUARD_WORDS))(), (C.c_float * (count + 2 * GUARD_WORDS))()
        sums = (C.c_float * count).from_buffer(sums_buffer, 4 * GUARD_WORDS)
        output = (C.c_float * count).from_buffer(output_buffer, 4 * GUARD_WORDS)

        def read_outputs(label):
            for pointer, buffer in ((ds_base, sums_buffer), (dy_base, output_buffer)):
                checked(driver, "cuMemcpyDtoH_v2", buffer, pointer, SIZE(C.sizeof(buffer)))
                bits = (C.c_uint * (count + 2 * GUARD_WORDS)).from_buffer(buffer)
                if bits[:GUARD_WORDS] + bits[-GUARD_WORDS:] != [0x7fc00000] * (2 * GUARD_WORDS):
                    raise AssertionError(f"{label}/{pattern}/{rows}: output guard overwritten")
            if bytes(sums) != bytes(expected_sums):
                raise AssertionError(f"{label}/{pattern}/{rows}: residual output differs bitwise")

        for label, operation in operations.items():
            # Poison outputs so skipped lanes cannot inherit a previous result.
            checked(driver, "cuMemsetD32Async", ds_base, C.c_uint(0x7fc00000), SIZE(count + 2 * GUARD_WORDS), stream)
            checked(driver, "cuMemsetD32Async", dy_base, C.c_uint(0x7fc00000), SIZE(count + 2 * GUARD_WORDS), stream)
            operation()
            checked(driver, "cuStreamSynchronize", stream)
            read_outputs(label)
            errors[label] = numerical_errors(output, expected, f"{label}/{pattern}/{rows}")
            results[label] = bytes(output)
        if results["original_fused"] != results["two_launch_reference"]:
            raise AssertionError("original fused/reference reduction no longer matches bitwise")
        record = {"rows": rows, "pattern": pattern, "eps_f32": eps, "threads": threads,
                  "residual_bitwise_equal": True,
                  "reference_bitwise_equal": results["fused"] == results["two_launch_reference"],
                  "output_guards_unchanged": True,
                  "cpu_double_errors": errors, "explicit_device_bytes": (4 * count + WIDTH) * 4 + 16 * GUARD_WORDS}
        if repeats:
            timings, node_counts, last_label = graph_timings(driver, stream, operations, repeats, samples)
            read_outputs("graph_replay")
            if bytes(output) != results[last_label]:
                raise AssertionError("graph replay differs from the checked direct launch")
            record["graph_replay_matches_checked_output"] = True
            record["graph_node_counts"] = node_counts
            record["graph_event_us_per_call_samples"] = timings
            medians = {label: statistics.median(values) for label, values in timings.items()}
            record["graph_event_us_per_call_median"] = medians
            record["original_over_fused_ratio"] = medians["original_fused"] / medians["fused"]
            record["two_launch_over_fused_ratio"] = medians["two_launch_reference"] / medians["fused"]
        return record
    finally:
        # Owned context destruction is the final cleanup if an asynchronous fault
        # prevents individual frees; never reset another process's GPU context.
        for pointer in device:
            checked(driver, "cuMemFree_v2", pointer)


def self_check():
    """Launch contract failures are checked without requiring a GPU or DLL."""
    assert select_threads(1) == select_threads(16) == 512
    assert select_threads(17) == select_threads(1024) == 128
    assert select_threads(1, 32) == 32
    assert validate_case(1, WIDTH, 1e-6, 256) > 0
    validate_case(1024, WIDTH, 1e-6, 32)
    pointers = [16, 32784, 65552, 98320, 131088]
    validate_case(1, WIDTH, 1e-6, 256, pointers)
    invalid = [(0, WIDTH, 1e-6, 256), (1025, WIDTH, 1e-6, 256),
               (1, 4095, 1e-6, 256), (1, WIDTH, 1e-6, 96)]
    invalid += [(1, WIDTH, eps, 256) for eps in (0, -1, float("inf"), float("nan"), 1e-100, 1e100)]
    for args in invalid:
        try:
            validate_case(*args)
        except ValueError:
            pass
        else:
            raise AssertionError(f"invalid launch accepted: {args}")
    for buffers in ([0] + pointers[1:], [17] + pointers[1:], pointers[:4],
                    [16, 32] + pointers[2:]):
        try:
            validate_case(1, WIDTH, 1e-6, 256, buffers)
        except ValueError:
            pass
        else:
            raise AssertionError("invalid buffers accepted")
    print("PASS launch contract: shapes, epsilon, geometry, alignment, overlapping buffers")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nvrtc", type=Path, help="Path to nvrtc64_120_0.dll")
    parser.add_argument("--output", type=Path, help="Optional JSON report destination")
    parser.add_argument("--device", type=int, default=0)
    parser.add_argument("--repeats", type=int, default=100, help="Calls in graph; 0 disables timings, max 1000")
    parser.add_argument("--samples", type=int, default=9, help="Timed graph replays, 3..31")
    parser.add_argument("--threads", type=int, choices=(32, 64, 128, 256, 512, 1024), default=None,
                        help="Override default: 512 threads for <=16 rows, otherwise 128")
    parser.add_argument("--scalar", action="store_true", help="Calibration: scalar candidate loads/stores")
    parser.add_argument("--rows", type=int, nargs="+", default=[1, 33, 128, 257], help="Random cases, 1..1024")
    parser.add_argument("--eps", type=float, default=1e-6)
    parser.add_argument("--self-check", action="store_true", help="Check invalid launch contracts without GPU")
    args = parser.parse_args()
    if args.self_check:
        self_check()
        return
    if os.name != "nt" or C.sizeof(VOID) != 8:
        parser.error("This check requires 64-bit Python on Windows.")
    if not args.nvrtc:
        parser.error("--nvrtc is required unless --self-check is used")
    if not 0 <= args.repeats <= 1000 or args.device < 0 or not 3 <= args.samples <= 31:
        parser.error("repeats must be 0..1000, device nonnegative and samples 3..31")
    try:
        for rows in args.rows:
            validate_case(rows, WIDTH, args.eps, select_threads(rows, args.threads))
    except ValueError as error:
        parser.error(str(error))
    dll = args.nvrtc.resolve(strict=True)
    source = (Path(__file__).resolve().parents[1] / "kernels/residual-rms-f32.cu").read_bytes()
    with os.add_dll_directory(str(dll.parent)):
        nvrtc = C.WinDLL(str(dll))
        driver = C.WinDLL("nvcuda.dll")
        checked(driver, "cuInit", 0)
        device = C.c_int()
        checked(driver, "cuDeviceGet", C.byref(device), args.device)
        name = C.create_string_buffer(256)
        checked(driver, "cuDeviceGetName", name, len(name), device)
        major, minor, driver_version = C.c_int(), C.c_int(), C.c_int()
        checked(driver, "cuDeviceComputeCapability", C.byref(major), C.byref(minor), device)
        checked(driver, "cuDriverGetVersion", C.byref(driver_version))
        architecture = major.value * 10 + minor.value
        if architecture not in (75, 86):
            raise RuntimeError(f"Unsupported check GPU compute_{architecture}; expected 75 or 86")
        hardware = {}
        for label, attribute in (("multiprocessors", 16), ("peak_memory_clock_khz", 36),
                                 ("memory_bus_bits", 37), ("l2_cache_bytes", 38)):
            value = C.c_int()
            checked(driver, "cuDeviceGetAttribute", C.byref(value), attribute, device)
            hardware[label] = value.value
        nvmajor, nvminor = C.c_int(), C.c_int()
        checked(nvrtc, "nvrtcVersion", C.byref(nvmajor), C.byref(nvminor))
        builtins = C.WinDLL(str(dll.with_name(f"nvrtc-builtins64_{nvmajor.value}{nvminor.value}.dll")))
        ptx = {arch: compile_ptx(nvrtc, source, arch, args.threads or 128, not args.scalar) for arch in (75, 86)}
        report = {"status": "pass", "experimental": True, "production_integration": False,
                  "utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  "device": name.value.decode(), "compute_capability": architecture,
                  "device_attributes": hardware,
                  "driver_api_version": driver_version.value,
                  "nvrtc_version": f"{nvmajor.value}.{nvminor.value}", "nvrtc_dll": str(dll),
                  "source_sha256": hashlib.sha256(source).hexdigest(),
                  "checker_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                  "ptx_sha256": {str(arch): hashlib.sha256(code).hexdigest() for arch, code in ptx.items()},
                  "compiled_architectures": list(ptx), "executed_architecture": architecture,
                  "columns": WIDTH, "dtype": "f32", "fast_math": False,
                  "threads_override": args.threads, "default_geometry": "512 threads for rows<=16; otherwise 128", "vectorize": not args.scalar,
                  "oracle_tolerance": "abs_error <= 2e-6 + 2e-6 * abs(cpu_double)",
                  "timing_repeats": args.repeats, "timing_samples": args.samples,
                  "timing_method": "CUDA graph chain with in-graph external timing event nodes; >=150 ms warmup per variant; seeded shuffled sample order",
                  "timing_limitations": "Warm reused buffers; GPU graph scheduling included. Synthetic operator, not llama.cpp or end-to-end speed; clocks are not locked.",
                  "cases": []}
        context, module, stream = VOID(), VOID(), VOID()
        checked(driver, "cuCtxCreate_v2", C.byref(context), 0, device)
        try:
            checked(driver, "cuStreamCreate", C.byref(stream), 1)
            checked(driver, "cuModuleLoadData", C.byref(module), ptx[architecture])
            functions = []
            resources = {}
            for symbol in (b"residual_rms_f32", b"baseline_residual_rms_f32", b"reference_add_f32", b"reference_rms_f32", b"residual_rms_f32_small"):
                function = VOID()
                checked(driver, "cuModuleGetFunction", C.byref(function), module, symbol)
                functions.append(function)
                resources[symbol.decode()] = {}
                for label, attribute in (("registers_per_thread", 4), ("static_shared_bytes", 1), ("local_bytes_per_thread", 3)):
                    value = C.c_int()
                    checked(driver, "cuFuncGetAttribute", C.byref(value), attribute, function)
                    resources[symbol.decode()][label] = value.value
            report["kernel_resources"] = resources
            cases = [(rows, "random") for rows in dict.fromkeys(args.rows)]
            cases += [(3, "zero"), (5, "cancellation"), (7, "small"), (9, "dynamic_range"), (65, "rounding")]
            for rows, pattern in cases:
                threads = select_threads(rows, args.threads)
                case_functions = ([functions[4], *functions[1:4]]
                                  if args.threads is None and threads == 512 else functions[:4])
                case = run_case(driver, case_functions, stream, rows, pattern, args.eps, threads,
                                args.repeats if pattern == "random" else 0, args.samples)
                report["cases"].append(case)
                print(f"PASS {pattern} rows={rows} error={case['cpu_double_errors']['fused']['max_abs_error']:.3g}", flush=True)
            if args.output:
                args.output.parent.mkdir(parents=True, exist_ok=True)
                args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
            print(json.dumps(report, indent=2))
        finally:
            # Destroying an owned context releases all its allocations even if a
            # previous CUDA fault prevents a more specific teardown call.
            try:
                if stream:
                    checked(driver, "cuStreamDestroy_v2", stream)
                if module:
                    checked(driver, "cuModuleUnload", module)
            finally:
                checked(driver, "cuCtxDestroy_v2", context)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, AssertionError, ValueError) as error:
        print(f"FAIL / UNAVAILABLE: {error}", file=sys.stderr)
        sys.exit(1)
