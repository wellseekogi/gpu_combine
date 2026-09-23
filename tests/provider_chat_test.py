"""General chat inference through the outbound, owner-controlled provider."""
import concurrent.futures
import importlib.util
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location("chat_provider", Path(__file__).parents[1] / "provider" / "provider.py")
provider = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provider)


class ProviderChatTests(unittest.TestCase):
    def setUp(self):
        self.worker = provider.Provider.__new__(provider.Provider)
        self.worker.args = SimpleNamespace(context=8192, once=True, coordinator="https://relay.example", pool="pool", node="node")
        self.worker.contract = {"modelDigest": "a" * 64, "runtime": "b" * 64, "template": "c" * 64}
        self.worker.base = "http://127.0.0.1:8081"
        self.worker.token = "test-provider-token"
        self.worker.stop = False
        self.worker.process = None
        self.worker.lease = None
        self.worker._initialize_guards()
        self.worker.start_runtime = Mock()
        self.worker.stop_runtime = Mock()
        self.task = {
            "kind": "chat", "taskId": "task", "lease": {"attemptId": "attempt", "epoch": 3},
            "model": {"digest": "a" * 64, "runtime": "b" * 64, "template": "c" * 64, "context": 8192},
            "messages": [{"role": "system", "content": "한국어로 답하세요."},
                         {"role": "user", "content": "GPU가 뭐야?"},
                         {"role": "assistant", "content": "병렬 계산에 쓰는 장치입니다."},
                         {"role": "user", "content": "LLM 실행에는 어떻게 쓰여?"}],
            "maxOutputTokens": 1024,
        }
        self.completion = {"choices": [{"message": {"role": "assistant", "content": "GPU에서 모델을 실행해 답변을 생성합니다."},
                                         "finish_reason": "stop"}],
                           "usage": {"prompt_tokens": 100, "completion_tokens": 25}}

    def tearDown(self):
        self.worker._clear_lease()

    def infer(self, completion=None, count=100):
        with patch.object(provider, "request_json", side_effect=[{"input_tokens": count}, completion or self.completion]) as request:
            result = self.worker.infer(self.task)
        return result, request

    def test_chat_keeps_conversation_and_returns_plain_text_with_usage(self):
        result, request = self.infer()
        body = request.call_args_list[1].args[1]
        self.assertEqual(body["messages"], self.task["messages"])
        self.assertNotIn("response_format", body)
        self.assertNotIn("tools", body)
        self.assertFalse(body["stream"])
        self.assertEqual(body["max_tokens"], 1024)
        self.assertEqual(request.call_args_list[0].args[0], self.worker.base + "/v1/chat/completions/input_tokens")
        self.assertEqual(request.call_args_list[0].args[1], body)
        self.assertEqual(result["raw"], self.completion["choices"][0]["message"]["content"])
        self.assertEqual(result["usage"], self.completion["usage"])
        self.assertEqual(result["attemptId"], "attempt")
        self.assertEqual(result["epoch"], 3)

    def test_only_role_and_content_are_forwarded(self):
        self.task["messages"][-1]["tool_calls"] = [{"function": {"name": "run_shell"}}]
        _, request = self.infer()
        self.assertEqual(set(request.call_args_list[1].args[1]["messages"][-1]), {"role", "content"})

    def test_chat_rejects_invalid_inputs_before_contacting_runtime(self):
        valid = self.task["messages"]
        invalid = [None, [], valid * 17, [{"role": "tool", "content": "x"}],
                   [{"role": "user", "content": []}], [{"role": "user", "content": "   "}],
                   [{"role": "user", "content": "x" * 16001}],
                   [{"role": "assistant", "content": "x"}],
                   [{"role": "user", "content": "가" * 16000}, {"role": "user", "content": "나"}]]
        for messages in invalid:
            with self.subTest(messages=str(messages)[:80]):
                self.task["messages"] = messages
                with patch.object(provider, "request_json") as request:
                    with self.assertRaises(RuntimeError):
                        self.worker.infer(self.task)
                request.assert_not_called()

    def test_chat_rejects_invalid_output_limits_and_unknown_task_kind(self):
        for value in [None, True, 0, -1, 4097, "1024"]:
            with self.subTest(value=value), patch.object(provider, "request_json") as request:
                self.task["maxOutputTokens"] = value
                with self.assertRaises(RuntimeError):
                    self.worker.infer(self.task)
                request.assert_not_called()
        self.task["kind"] = "run-code"
        with patch.object(provider, "request_json") as request:
            with self.assertRaisesRegex(RuntimeError, "Unsupported"):
                self.worker.infer(self.task)
        request.assert_not_called()

    def test_exact_context_overflow_and_invalid_token_count_never_generate(self):
        for count in [8000, None, True, -1, "100"]:
            with self.subTest(count=count), patch.object(provider, "request_json", return_value={"input_tokens": count}) as request:
                with self.assertRaises(RuntimeError):
                    self.worker.infer(self.task)
                self.assertEqual(request.call_count, 1)

    def test_invalid_runtime_output_is_never_returned_for_settlement(self):
        responses = [[], {}, {"choices": []}, {"choices": [None]}, {"choices": [{"message": None}]}]
        for content in [None, {}, " ", "가" * 10923, "\x01" * 8000]:
            responses.append({"choices": [{"message": {"content": content}, "finish_reason": "stop"}]})
        responses.append({"choices": [{"message": {"content": "text"}, "finish_reason": "tool_calls"}]})
        for response in responses:
            with self.subTest(response=str(response)[:80]), patch.object(provider, "request_json", side_effect=[{"input_tokens": 100}, response]):
                with self.assertRaises(RuntimeError):
                    self.worker.infer(self.task)

    def test_output_stopped_at_requested_token_limit_remains_usable(self):
        self.completion["choices"][0]["finish_reason"] = "length"
        result, _ = self.infer()
        self.assertEqual(result["finishReason"], "length")
        self.assertTrue(result["raw"])

    def test_long_natural_language_completions_fit_chat_result_budget(self):
        self.completion["choices"][0]["message"]["content"] = "가" * 10000
        result, _ = self.infer()
        self.assertEqual(result["raw"], "가" * 10000)

    def test_worker_advertises_chat_and_submits_actual_runtime_text(self):
        calls = []

        def request(url, payload=None, token=None, **_kwargs):
            if url.startswith(self.worker.base):
                return {"input_tokens": 100} if url.endswith("/input_tokens") else self.completion
            calls.append(payload)
            if payload["action"] == "status":
                return {"result": {"paused": False}}
            if payload["action"] == "poll":
                self.assertEqual(payload["payload"]["capabilities"], ["chat", "renter-model", "rental-session"])
                return {"result": {"task": self.task, "leaseRemainingMs": 30000}}
            self.assertEqual(payload["action"], "submit")
            self.assertEqual(payload["payload"]["raw"], self.completion["choices"][0]["message"]["content"])
            return {"result": {"receipt": "receipt"}}

        def immediate(fn, task):
            future = concurrent.futures.Future()
            future.set_result(fn(task))
            return future

        executor = Mock()
        executor.submit.side_effect = immediate
        with patch.object(provider, "request_json", side_effect=request), \
                patch.object(provider.concurrent.futures, "ThreadPoolExecutor", return_value=executor), \
                patch.object(provider.time, "monotonic", return_value=0), patch.object(provider.time, "sleep"):
            self.worker.run()
        self.assertEqual([call["action"] for call in calls], ["status", "poll", "poll", "submit"])
        self.worker.stop_runtime.assert_called_once()

    def test_public_download_matches_packaged_provider(self):
        root = Path(__file__).parents[1]
        self.assertEqual((root / "provider/provider.py").read_bytes(), (root / "public/provider.py").read_bytes())


if __name__ == "__main__":
    unittest.main()
