// Experimental microkernel: contiguous F32 [rows,4096], weights F32 [4096].
// Baseline: 1024 threads/row. Candidate: RMS_THREADS (128); small-row entry: 512.
// All five buffers distinct and 16-byte aligned; see README for launch contract.
// Caller must validate dimensions and finite, positive eps. No graph integration.
// Outputs BOTH the rounded residual sum and its weighted RMS normalization.
constexpr int WIDTH = 4096;
constexpr int THREADS = 1024;

__device__ float row_scale(float square_sum, float eps) {
    __shared__ float partial[32];
    const int lane = threadIdx.x & 31;
    for (int mask = 16; mask; mask >>= 1)
        square_sum += __shfl_xor_sync(0xffffffff, square_sum, mask);
    if (lane == 0) partial[threadIdx.x >> 5] = square_sum;
    __syncthreads();
    square_sum = partial[lane];
    for (int mask = 16; mask; mask >>= 1)
        square_sum += __shfl_xor_sync(0xffffffff, square_sum, mask);
    return rsqrtf(square_sum / WIDTH + eps);
}

extern "C" __global__ void baseline_residual_rms_f32(
    const float * x, const float * residual, const float * weight,
    float * sum, float * output, float eps) {
    const int base = blockIdx.x * WIDTH + threadIdx.x;
    float values[WIDTH / THREADS];
    float squares = 0.0f;
    #pragma unroll
    for (int k = 0; k < WIDTH / THREADS; ++k) {
        const int i = base + k * THREADS;
        // Preserve the standalone ADD's FP32 rounding before squaring.
        values[k] = __fadd_rn(x[i], residual[i]);
        sum[i] = values[k];
        squares += values[k] * values[k];
    }
    const float scale = row_scale(squares, eps);
    #pragma unroll
    for (int k = 0; k < WIDTH / THREADS; ++k) {
        const int col = threadIdx.x + k * THREADS;
        output[base + k * THREADS] = (scale * values[k]) * weight[col];
    }
}

// Two-launch comparison, deliberately not called the compiled llama.cpp baseline.
extern "C" __global__ void reference_add_f32(
    const float * x, const float * residual, float * sum, int count) {
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < count) sum[i] = __fadd_rn(x[i], residual[i]);
}

extern "C" __global__ void reference_rms_f32(
    const float * sum, const float * weight, float * output, float eps) {
    const int base = blockIdx.x * WIDTH + threadIdx.x;
    float squares = 0.0f;
    #pragma unroll
    for (int k = 0; k < WIDTH / THREADS; ++k) {
        const float value = sum[base + k * THREADS];
        squares += value * value;
    }
    const float scale = row_scale(squares, eps);
    #pragma unroll
    for (int k = 0; k < WIDTH / THREADS; ++k) {
        const int col = threadIdx.x + k * THREADS;
        output[base + k * THREADS] = (scale * sum[base + k * THREADS]) * weight[col];
    }
}

// Compile-time geometry is intentionally exposed for calibration on each GPU.
#ifndef RMS_THREADS
#define RMS_THREADS 128
#endif
#ifndef RMS_VECTORIZE
#define RMS_VECTORIZE 1
#endif
static_assert(RMS_THREADS >= 32 && RMS_THREADS <= 1024 &&
              (RMS_THREADS & (RMS_THREADS - 1)) == 0, "invalid RMS_THREADS");

template<int N>
__device__ __forceinline__ float candidate_scale(float squares, float eps) {
    for (int mask = 16; mask; mask >>= 1)
        squares += __shfl_xor_sync(0xffffffff, squares, mask);
    if (N > 32) {
        __shared__ float partial[N / 32];
        const int lane = threadIdx.x & 31;
        if (lane == 0) partial[threadIdx.x >> 5] = squares;
        __syncthreads();
        squares = lane < N / 32 ? partial[lane] : 0.0f;
        for (int mask = N / 64; mask; mask >>= 1)
            squares += __shfl_xor_sync(0xffffffff, squares, mask);
        squares = __shfl_sync(0xffffffff, squares, 0);
    }
    return rsqrtf(squares / WIDTH + eps);
}

template<int N>
__device__ __forceinline__ void residual_rms_impl(
    const float * __restrict__ x, const float * __restrict__ residual,
    const float * __restrict__ weight, float * __restrict__ sum,
    float * __restrict__ output, float eps) {
#if RMS_VECTORIZE
    constexpr int VECTORS = WIDTH / 4;
    const int base = blockIdx.x * VECTORS + threadIdx.x;
    float4 values[VECTORS / N];
    float4 squares = {0.0f, 0.0f, 0.0f, 0.0f};
    #pragma unroll
    for (int k = 0; k < VECTORS / N; ++k) {
        const int i = base + k * N;
        const float4 a = reinterpret_cast<const float4 *>(x)[i];
        const float4 b = reinterpret_cast<const float4 *>(residual)[i];
        float4 v;
        v.x = __fadd_rn(a.x, b.x); v.y = __fadd_rn(a.y, b.y);
        v.z = __fadd_rn(a.z, b.z); v.w = __fadd_rn(a.w, b.w);
        values[k] = v;
        reinterpret_cast<float4 *>(sum)[i] = v;
        squares.x += v.x * v.x; squares.y += v.y * v.y;
        squares.z += v.z * v.z; squares.w += v.w * v.w;
    }
    const float scale = candidate_scale<N>((squares.x + squares.y) + (squares.z + squares.w), eps);
    #pragma unroll
    for (int k = 0; k < VECTORS / N; ++k) {
        const int col = threadIdx.x + k * N;
        const float4 w = reinterpret_cast<const float4 *>(weight)[col];
        float4 v = values[k];
        v.x = (scale * v.x) * w.x; v.y = (scale * v.y) * w.y;
        v.z = (scale * v.z) * w.z; v.w = (scale * v.w) * w.w;
        reinterpret_cast<float4 *>(output)[base + k * N] = v;
    }
#else
    const int base = blockIdx.x * WIDTH + threadIdx.x;
    float values[WIDTH / N];
    float squares = 0.0f;
    #pragma unroll
    for (int k = 0; k < WIDTH / N; ++k) {
        const int i = base + k * N;
        values[k] = __fadd_rn(x[i], residual[i]);
        sum[i] = values[k];
        squares += values[k] * values[k];
    }
    const float scale = candidate_scale<N>(squares, eps);
    #pragma unroll
    for (int k = 0; k < WIDTH / N; ++k) {
        const int col = threadIdx.x + k * N;
        output[base + k * N] = (scale * values[k]) * weight[col];
    }
#endif
}

// Separate entry points share one implementation; the host chooses geometry.
extern "C" __global__ void residual_rms_f32(
    const float * x, const float * residual, const float * weight,
    float * sum, float * output, float eps) {
    residual_rms_impl<RMS_THREADS>(x, residual, weight, sum, output, eps);
}

extern "C" __global__ void residual_rms_f32_small(
    const float * x, const float * residual, const float * weight,
    float * sum, float * output, float eps) {
    residual_rms_impl<512>(x, residual, weight, sum, output, eps);
}
