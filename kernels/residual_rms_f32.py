"""TileLang FP32 residual + weighted RMSNorm; caller-owned input/output buffers.

Factories return cached CUDA kernels. See README.md for the launch contract.
Pass stream=torch.cuda.current_stream(device).cuda_stream explicitly on launch.
Imports are lazy so invalid geometry can be checked without a GPU toolchain.
"""
from functools import lru_cache

WIDTH = 4096
THREAD_COUNTS = (32, 64, 128, 256, 512, 1024)
COMPILE_FLAGS = ["--fmad=false", "--ftz=false", "--prec-div=true", "--prec-sqrt=true"]


def _geometry(rows, threads, vectorize):
    if type(rows) is not int or not 1 <= rows <= 1024:
        raise ValueError("rows must be an integer from 1 to 1024")
    if threads is None:
        # Retained CUDA calibration; remeasure this split for TileLang on each GPU.
        threads = 512 if rows <= 16 else 128
    if type(threads) is not int or threads not in THREAD_COUNTS:
        raise ValueError("threads must be a power of two from 32 to 1024")
    if type(vectorize) is not bool:
        raise ValueError("vectorize must be a bool")
    return threads, 4 if vectorize else 1


def _compile(program):
    import tilelang

    return tilelang.compile(
        program, target="cuda", execution_backend="nvrtc",
        pass_configs={"tl.enable_fast_math": False}, compile_flags=COMPILE_FLAGS,
    )


@lru_cache(maxsize=None, typed=True)
def residual_rms_f32(rows, threads=None, vectorize=True):
    """Build (x, residual, weight, sum_out, output, eps) -> None."""
    threads, vec = _geometry(rows, threads, vectorize)
    import tilelang.language as T

    layout = T.Fragment(
        (1, WIDTH),
        forward_fn=lambda i, j: ((j // vec) % threads,
                                 (j // (threads * vec)) * vec + j % vec),
    )

    @T.prim_func
    def main(
        x: T.Tensor((rows, WIDTH), "float32"),
        residual: T.Tensor((rows, WIDTH), "float32"),
        weight: T.Tensor((WIDTH,), "float32"),
        sum_out: T.Tensor((rows, WIDTH), "float32"),
        output: T.Tensor((rows, WIDTH), "float32"),
        eps: T.float32,
    ):
        with T.Kernel(rows, threads=threads) as row:
            values = T.alloc_fragment((1, WIDTH), "float32")
            squares = T.alloc_fragment((1, WIDTH), "float32")
            scale = T.alloc_fragment((1,), "float32")
            T.annotate_layout({values: layout, squares: layout})
            T.copy(x[row, 0], values, coalesced_width=vec)
            T.copy(residual[row, 0], squares, coalesced_width=vec)
            for i, j in T.Parallel(1, WIDTH, coalesced_width=vec):
                # Match standalone ADD's FP32 round-to-nearest before squaring.
                values[i, j] = T.ieee_add(values[i, j], squares[i, j])
                squares[i, j] = values[i, j] * values[i, j]
            T.copy(values, sum_out[row, 0], coalesced_width=vec)
            T.reduce_sum(squares, scale, dim=1)
            for i in T.Parallel(1):
                scale[i] = T.rsqrt(scale[i] / WIDTH + eps)
            for i, j in T.Parallel(1, WIDTH, coalesced_width=vec):
                output[row, j] = (scale[i] * values[i, j]) * weight[j]

    return _compile(main)


def baseline_residual_rms_f32(rows):
    """TileLang 1024-thread scalar comparison, not the original CUDA binary."""
    return residual_rms_f32(rows, threads=1024, vectorize=False)


def residual_rms_f32_small(rows, vectorize=True):
    return residual_rms_f32(rows, threads=512, vectorize=vectorize)


@lru_cache(maxsize=None, typed=True)
def reference_add_f32(count):
    """Build (x_flat, residual_flat, sum_flat) -> None, with a masked tail."""
    if type(count) is not int or not 1 <= count <= 1024 * WIDTH:
        raise ValueError("count must be an integer from 1 to 4194304")
    import tilelang.language as T

    @T.prim_func
    def main(
        x: T.Tensor((count,), "float32"),
        residual: T.Tensor((count,), "float32"),
        sum_out: T.Tensor((count,), "float32"),
    ):
        with T.Kernel(T.ceildiv(count, 256), threads=256) as block:
            for col in T.Parallel(256):
                index = block * 256 + col
                if index < count:
                    sum_out[index] = T.ieee_add(x[index], residual[index])

    return _compile(main)


@lru_cache(maxsize=None, typed=True)
def reference_rms_f32(rows):
    """Build (sum_out, weight, output, eps) -> None for the two-launch reference."""
    threads, vec = _geometry(rows, 1024, False)
    import tilelang.language as T

    layout = T.Fragment((1, WIDTH), forward_fn=lambda i, j: (j % threads, j // threads))

    @T.prim_func
    def main(
        sum_out: T.Tensor((rows, WIDTH), "float32"),
        weight: T.Tensor((WIDTH,), "float32"),
        output: T.Tensor((rows, WIDTH), "float32"),
        eps: T.float32,
    ):
        with T.Kernel(rows, threads=threads) as row:
            values = T.alloc_fragment((1, WIDTH), "float32")
            squares = T.alloc_fragment((1, WIDTH), "float32")
            scale = T.alloc_fragment((1,), "float32")
            T.annotate_layout({values: layout, squares: layout})
            T.copy(sum_out[row, 0], values, coalesced_width=vec)
            for i, j in T.Parallel(1, WIDTH, coalesced_width=vec):
                squares[i, j] = values[i, j] * values[i, j]
            T.reduce_sum(squares, scale, dim=1)
            for i in T.Parallel(1):
                scale[i] = T.rsqrt(scale[i] / WIDTH + eps)
            for i, j in T.Parallel(1, WIDTH, coalesced_width=vec):
                output[row, j] = (scale[i] * values[i, j]) * weight[j]

    return _compile(main)
