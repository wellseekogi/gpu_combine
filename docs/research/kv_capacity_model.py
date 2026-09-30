"""Reproduce the analytical examples in kv-cache-scheduling-research-ko.md.

No GPU, network, service state, or third-party package is used.
These are capacity/transfer estimates, NOT performance measurements.
Run: python docs/research/kv_capacity_model.py
"""
import json


def main():
    # Qwen's public Qwen3-4B-Instruct-2507 config; local GGUF identity is unverified.
    layers, kv_heads, head_dim, bytes_per_element = 36, 8, 128, 2
    per_token = 2 * layers * kv_heads * head_dim * bytes_per_element
    gib = 1024 ** 3
    tokens = 8192
    payload_bytes = per_token * tokens
    count, shared, private = 16, 2048, 2048
    unshared_bytes = count * (shared + private) * per_token
    shared_bytes = (shared + count * private) * per_token
    result = {
        "kind": "analytical estimates, not GPU benchmarks",
        "model_config_source": "https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507/blob/main/config.json",
        "assumptions": {
            "layers": layers, "kv_heads": kv_heads, "head_dim": head_dim,
            "kv_bytes_per_element": bytes_per_element,
            "full_attention": True,
            "excludes": ["weights", "workspace", "alignment", "metadata", "fragmentation", "transport overhead"],
        },
        "kv_bytes_per_token": per_token,
        "kv_kib_per_token": per_token / 1024,
        "single_sequence_gib": {str(n): n * per_token / gib for n in (1024, 4096, 8192, 32768)},
        "eight_sequences_8192_tokens_gib": 8 * payload_bytes / gib,
        "raw_transfer_lower_bound_seconds": {
            str(gbps): round(payload_bytes * 8 / (gbps * 1e9), 6)
            for gbps in (0.1, 1, 10, 25, 100)
        },
        "assumed_prefill_comparison": [
            {
                "assumed_prefill_tokens_per_second": speed,
                "prefill_seconds": round(tokens / speed, 6),
                "transfer_break_even_gbps_ignoring_overhead": round(per_token * speed * 8 / 1e9, 6),
            }
            for speed in (1000, 3000)
        ],
        "ideal_shared_prefix_example": {
            "sequences": count, "shared_tokens": shared, "private_tokens_each": private,
            "unshared_gib": unshared_bytes / gib, "physically_shared_gib": shared_bytes / gib,
            "saving_fraction": 1 - shared_bytes / unshared_bytes,
            "requires": "engine-supported physical block sharing within an allowed isolation domain",
        },
        "polling_gap_model": {
            "assumed_mean_gap_seconds": 4.5,
            "assumption": "uniform completion phase: mean detection wait 1.5s plus post-submit sleep 3s; excludes HTTP time",
            "useful_inference_time_fraction": {str(s): round(s / (s + 4.5), 6) for s in (2, 10, 60)},
        },
    }
    # Qwen3-32B public config: full-attention analytical estimates.
    large_per_token = 2 * 64 * 8 * 128 * 2
    activation_per_token = 5120 * 2
    large_payload = tokens * large_per_token
    result["distributed_qwen3_32b_example"] = {
        "source": "https://huggingface.co/Qwen/Qwen3-32B/blob/main/config.json",
        "kv_kib_per_token": large_per_token / 1024,
        "kv_gib_8192_tokens_one_session": large_payload / gib,
        "kv_gib_per_stage_two_equal_layer_stages_one_session": large_payload / gib / 2,
        "kv_gib_per_stage_two_equal_layer_stages_four_sessions": large_payload / gib / 2 * 4,
        "activation_kib_per_decode_token_per_boundary": activation_per_token / 1024,
        "activation_mib_8192_token_prefill_per_boundary": activation_per_token * tokens / 1024 ** 2,
        "activation_prefill_transfer_seconds_at_1gbps": activation_per_token * tokens * 8 / 1e9,
        "whole_kv_transfer_seconds_at_1gbps": large_payload * 8 / 1e9,
        "one_of_two_stages_kv_transfer_seconds_at_1gbps": large_payload / 2 * 8 / 1e9,
        "note": "One BF16/FP16 tensor; excludes protocol traffic, copies, round trips, scheduling, and retries.",
    }
    result["hypothetical_pipeline_latency"] = [
        {
            "one_way_ms_per_crossing": delay,
            "sequential_network_crossings_per_token": 4,
            "assumed_total_compute_ms": 60,
            "token_latency_lower_bound_ms": 60 + 4 * delay,
            "tokens_per_second_upper_bound": round(1000 / (60 + 4 * delay), 6),
        }
        for delay in (1, 20, 50)
    ]
    result["illustrative_two_12gib_gpu_admission"] = {
        "assumed_weight_gib_each": 9,
        "assumed_workspace_and_headroom_gib_each": 1.5,
        "kv_gib_each_per_8192_token_session": 1,
        "one_session_total_gib_each": 11.5,
        "two_sessions_total_gib_each": 12.5,
        "note": "Assumed 18GiB resident model evenly split; not measured Qwen GGUF size or guaranteed balanced placement.",
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

