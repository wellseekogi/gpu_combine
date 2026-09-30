"""Check all TileLang residual/RMS entries against the existing F32/double oracle.

Requires CUDA-enabled PyTorch, TileLang and its CUDA compiler for GPU checks.
--self-check uses only the standard library. Missing dependencies never pass.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import random
import statistics
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from kernels import residual_rms_f32 as kernels

_spec = importlib.util.spec_from_file_location("cuda_reference_check", Path(__file__).with_name("check-cuda-kernel.py"))
reference = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(reference)
WIDTH, GUARD_WORDS = reference.WIDTH, reference.GUARD_WORDS


def read_guarded(torch, buffer, label):
    values = buffer.cpu()
    bits = values.view(torch.int32)
    if bits[:GUARD_WORDS].tolist() + bits[-GUARD_WORDS:].tolist() != [0x7FC00000] * (2 * GUARD_WORDS):
        raise AssertionError(f"{label}: output guard overwritten")
    return reference.host(values[GUARD_WORDS:-GUARD_WORDS].tolist())


def check_add_tail(torch, stream):
    count = 257
    x = reference.host((2 ** 24) * (-1 if i % 2 else 1) for i in range(count))
    residual = reference.host((-1, 1, 3, -3)[i % 4] for i in range(count))
    expected = reference.host(a + b for a, b in zip(x, residual))
    dx, dr = [torch.frombuffer(values, dtype=torch.float32).to(stream.device)
              for values in (x, residual)]
    buffer = torch.empty(count + 2 * GUARD_WORDS, dtype=torch.float32, device=stream.device)
    buffer.view(torch.int32).fill_(0x7FC00000)
    kernels.reference_add_f32(count)(dx, dr, buffer[GUARD_WORDS:-GUARD_WORDS], stream=stream.cuda_stream)
    stream.synchronize()
    if bytes(read_guarded(torch, buffer, "ADD tail")) != bytes(expected):
        raise AssertionError("ADD tail output differs bitwise")
    print("PASS TileLang ADD masked tail count=257", flush=True)
    return {"count": count, "residual_bitwise_equal": True, "output_guards_unchanged": True}


def graph_timings(torch, stream, operations, repeats, samples, verify_replay):
    """Time captured calls with real event nodes, excluding Python launch gaps."""
    graphs, events = {}, {}
    for label, operation in operations.items():
        graph = torch.cuda.CUDAGraph()
        start = torch.cuda.Event(enable_timing=True, external=True)
        stop = torch.cuda.Event(enable_timing=True, external=True)
        start.record(stream)
        stop.record(stream)
        stream.synchronize()
        with torch.cuda.graph(graph, stream=stream):
            start.record(stream)
            for _ in range(repeats):
                operation()
            stop.record(stream)
        graphs[label], events[label] = graph, (start, stop)
        verify_replay(label, graph)
        until = time.perf_counter() + 0.15
        while time.perf_counter() < until:
            graph.replay()
            stream.synchronize()
    timings = {label: [] for label in operations}
    rng = random.Random(20260929)
    for _ in range(samples):
        order = list(operations)
        rng.shuffle(order)
        for label in order:
            graphs[label].replay()
            stream.synchronize()
            start, stop = events[label]
            timings[label].append(start.elapsed_time(stop) * 1000 / repeats)
    return timings


def run_case(torch, stream, rows, pattern, eps, threads, vectorize, repeats, samples):
    eps = reference.validate_case(rows, WIDTH, eps, threads)
    host_x, host_residual, host_weight = reference.make_inputs(rows, pattern)
    expected_sums, expected = reference.cpu_reference(host_x, host_residual, host_weight, eps)
    device = stream.device
    x, residual, weight = [torch.frombuffer(values, dtype=torch.float32).to(device)
                           for values in (host_x, host_residual, host_weight)]
    x, residual = x.reshape(rows, WIDTH), residual.reshape(rows, WIDTH)
    count = rows * WIDTH
    sum_base = torch.empty(count + 2 * GUARD_WORDS, dtype=torch.float32, device=device)
    output_base = torch.empty_like(sum_base)
    summed = sum_base[GUARD_WORDS:-GUARD_WORDS].reshape(rows, WIDTH)
    output = output_base[GUARD_WORDS:-GUARD_WORDS].reshape(rows, WIDTH)
    reference.validate_case(rows, WIDTH, eps, threads,
                            [t.data_ptr() for t in (x, residual, weight, summed, output)])
    fused = kernels.residual_rms_f32(rows, threads, vectorize)
    # Validate type checks again after the numerically equal valid cache entry exists.
    for args in ((float(rows), threads, vectorize), (rows, float(threads), vectorize),
                 (rows, threads, int(vectorize))):
        try:
            kernels.residual_rms_f32(*args)
        except ValueError:
            pass
        else:
            raise AssertionError(f"cached factory accepted invalid argument types: {args}")
    small = kernels.residual_rms_f32_small(rows, vectorize)
    baseline = kernels.baseline_residual_rms_f32(rows)
    add = kernels.reference_add_f32(count)
    rms = kernels.reference_rms_f32(rows)
    flat_x, flat_residual, flat_sum = x.reshape(-1), residual.reshape(-1), summed.reshape(-1)

    def split_reference():
        add(flat_x, flat_residual, flat_sum, stream=stream.cuda_stream)
        rms(summed, weight, output, eps, stream=stream.cuda_stream)

    # NVRTC 0.1.15 can misidentify a JSON-form CUDA target and default to stream 0.
    # Explicit streams also keep launches on the stream being graph-captured.
    operations = {
        "fused": lambda: fused(x, residual, weight, summed, output, eps, stream=stream.cuda_stream),
        "small_512": lambda: small(x, residual, weight, summed, output, eps, stream=stream.cuda_stream),
        "baseline_1024": lambda: baseline(x, residual, weight, summed, output, eps, stream=stream.cuda_stream),
        "two_launch_reference": split_reference,
    }

    def poison():
        for buffer in (sum_base, output_base):
            buffer.view(torch.int32).fill_(0x7FC00000)

    def read_outputs(label):
        actual_sum = read_guarded(torch, sum_base, f"{label}/{pattern}/{rows}/sum")
        if bytes(actual_sum) != bytes(expected_sums):
            actual_bits = memoryview(actual_sum).cast("B").cast("I")
            expected_bits = memoryview(expected_sums).cast("B").cast("I")
            index = next(i for i, (a, b) in enumerate(zip(actual_bits, expected_bits)) if a != b)
            raise AssertionError(f"{label}/{pattern}/{rows}/{index}: residual {actual_sum[index]} "
                                 f"!= {expected_sums[index]} (bits {actual_bits[index]:08x} != {expected_bits[index]:08x})")
        return read_guarded(torch, output_base, f"{label}/{pattern}/{rows}/output")

    results, errors = {}, {}
    for label, operation in operations.items():
        poison()
        operation()
        stream.synchronize()
        values = read_outputs(label)
        errors[label] = reference.numerical_errors(values, expected, f"{label}/{pattern}/{rows}")
        results[label] = bytes(values)
    record = {"rows": rows, "pattern": pattern, "eps_f32": eps, "threads": threads,
              "residual_bitwise_equal": True, "output_guards_unchanged": True,
              "reference_bitwise_equal": results["fused"] == results["two_launch_reference"],
              "cpu_double_errors": errors,
              "explicit_device_bytes": (4 * count + WIDTH) * 4 + 16 * GUARD_WORDS}
    if repeats:
        def verify_replay(label, graph):
            poison()
            graph.replay()
            stream.synchronize()
            if bytes(read_outputs(label)) != results[label]:
                raise AssertionError(f"{label}: graph replay differs from checked direct launch")

        timings = graph_timings(torch, stream, operations, repeats, samples, verify_replay)
        record["graph_replay_matches_checked_output"] = True
        record["graph_event_us_per_call_samples"] = timings
        record["graph_event_us_per_call_median"] = {label: statistics.median(values)
                                                  for label, values in timings.items()}
    return record


def self_check():
    reference.self_check()
    assert kernels._geometry(1, None, True) == (512, 4)
    assert kernels._geometry(17, None, False) == (128, 1)
    invalid = [(kernels.residual_rms_f32, args) for args in
               ((0,), (1025,), (True,), (1.0,), (1, 96), (1, True), (1, 128, 1))]
    invalid += [(kernels.reference_add_f32, (n,)) for n in (0, -1, True, 1.0, 1024 * WIDTH + 1)]
    invalid += [(kernels.baseline_residual_rms_f32, (0,)),
                (kernels.residual_rms_f32_small, (0,)), (kernels.reference_rms_f32, (0,))]
    for factory, args in invalid:
        try:
            factory(*args)
        except ValueError:
            pass
        else:
            raise AssertionError(f"invalid factory arguments accepted: {factory.__name__}{args}")
    for pattern in ("random", "zero", "cancellation", "small", "dynamic_range", "rounding"):
        x, residual, weight = reference.make_inputs(1, pattern)
        sums, expected = reference.cpu_reference(x, residual, weight, 1e-6)
        assert len(sums) == len(expected) == WIDTH
        assert bytes(sums) == bytes(reference.host(a + b for a, b in zip(x, residual)))
        reference.numerical_errors(reference.host(expected), expected, pattern)
    for bad in ([float("nan")], [float("inf")], [1.0], []):
        try:
            reference.numerical_errors(bad, [0.0], "self-check")
        except AssertionError:
            pass
        else:
            raise AssertionError("incorrect output accepted")
    print("PASS shared input patterns and double oracle (host-only; no GPU result)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-check", action="store_true")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--device", type=int, default=0)
    parser.add_argument("--rows", type=int, nargs="+", default=[1, 33, 128, 257])
    parser.add_argument("--eps", type=float, default=1e-6)
    parser.add_argument("--threads", type=int, choices=(32, 64, 128, 256, 512, 1024),
                        help="Override inherited geometry: 512 for <=16 rows, otherwise 128")
    parser.add_argument("--scalar", action="store_true", help="Disable candidate vectorization")
    parser.add_argument("--repeats", type=int, default=100, help="Calls per graph; 0 disables timing, max 1000")
    parser.add_argument("--samples", type=int, default=9, help="Timed graph replays, 3..31")
    args = parser.parse_args()
    if args.self_check:
        self_check()
        return
    if not 0 <= args.repeats <= 1000 or args.device < 0 or not 3 <= args.samples <= 31:
        parser.error("repeats must be 0..1000, device nonnegative and samples 3..31")
    try:
        for rows in args.rows:
            reference.validate_case(rows, WIDTH, args.eps, reference.select_threads(rows, args.threads))
    except ValueError as error:
        parser.error(str(error))
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA-enabled PyTorch and an available NVIDIA GPU are required")
    if args.device >= torch.cuda.device_count():
        raise ValueError("requested CUDA device does not exist")
    import tilelang

    with torch.cuda.device(args.device):
        stream = torch.cuda.Stream(device=args.device)
        report = {"status": "pass", "backend": "tilelang", "experimental": True,
                  "production_integration": False,
                  "utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  "device": torch.cuda.get_device_name(args.device),
                  "compute_capability": list(torch.cuda.get_device_capability(args.device)),
                  "torch_version": torch.__version__, "torch_cuda_version": torch.version.cuda,
                  "tilelang_version": tilelang.__version__,
                  "source_sha256": hashlib.sha256(Path(kernels.__file__).read_bytes()).hexdigest(),
                  "checker_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                  "oracle_sha256": hashlib.sha256(Path(reference.__file__).read_bytes()).hexdigest(),
                  "columns": WIDTH, "dtype": "f32", "threads_override": args.threads,
                  "compile_flags": kernels.COMPILE_FLAGS, "fast_math": False,
                  "vectorize": not args.scalar,
                  "default_geometry": "Inherited CUDA split; not calibrated for TileLang: 512 for rows<=16, otherwise 128",
                  "oracle_tolerance": "abs_error <= 2e-6 + 2e-6 * abs(cpu_double)",
                  "timing_repeats": args.repeats, "timing_samples": args.samples,
                  "timing_method": "CUDA graph with external GPU timing events; >=150 ms warmup; seeded shuffled samples",
                  "timing_limitations": "TileLang variants only; warm reused buffers, graph scheduling included, clocks unlocked; no CUDA or model speedup claim",
                  "cases": []}
        cases = [(rows, "random") for rows in dict.fromkeys(args.rows)]
        cases += [(3, "zero"), (5, "cancellation"), (7, "small"), (9, "dynamic_range"), (65, "rounding")]
        with torch.cuda.stream(stream):
            report["add_tail"] = check_add_tail(torch, stream)
            for rows, pattern in cases:
                case = run_case(torch, stream, rows, pattern, args.eps,
                                reference.select_threads(rows, args.threads), not args.scalar,
                                args.repeats if pattern == "random" else 0, args.samples)
                report["cases"].append(case)
                print(f"PASS TileLang {pattern} rows={rows} error={case['cpu_double_errors']['fused']['max_abs_error']:.3g}", flush=True)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ImportError, OSError, RuntimeError, AssertionError, ValueError) as error:
        print(f"FAIL / UNAVAILABLE: {error}", file=sys.stderr)
        sys.exit(1)
