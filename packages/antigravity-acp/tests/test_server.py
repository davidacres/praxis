import io
import json
import unittest
from unittest.mock import patch

from antigravity_acp.server import (
    Session,
    classify_tool_kind,
    format_tool_title,
)


class TestServerHelpers(unittest.TestCase):
    def test_classify_tool_kind(self):
        self.assertEqual(classify_tool_kind("run_command"), "execute")
        self.assertEqual(classify_tool_kind("read_file"), "read")
        self.assertEqual(classify_tool_kind("write_file"), "edit")
        self.assertEqual(classify_tool_kind("search_web"), "search")
        self.assertEqual(classify_tool_kind("custom_tool"), "other")

    def test_format_tool_title(self):
        self.assertEqual(
            format_tool_title("run_command", {"CommandLine": "git status --short"}),
            "Run: git status --short",
        )
        self.assertEqual(
            format_tool_title("read_file", {"Path": "/path/to/file.ts"}),
            "read_file: /path/to/file.ts",
        )
        self.assertEqual(
            format_tool_title("unknown", None),
            "Running unknown",
        )


class TestStepUpdateHandling(unittest.TestCase):
    def test_tool_lifecycle_notifications(self):
        session = Session("test-session-123", "/tmp")
        notifications = []

        def fake_send_notification(method, params):
            notifications.append((method, params))

        tool_active_line = json.dumps({
            "event": "step_update",
            "step_update": {
                "step_index": 4,
                "step_type": "tool",
                "state": "ACTIVE",
                "tool_name": "run_command",
                "tool_info": {
                    "name": "run_command",
                    "parameters": {"CommandLine": "npm test"}
                }
            }
        })

        tool_done_line = json.dumps({
            "event": "step_update",
            "step_update": {
                "step_index": 4,
                "step_type": "tool",
                "state": "DONE",
                "tool_name": "run_command",
                "tool_info": {
                    "name": "run_command",
                    "parameters": {"CommandLine": "npm test"},
                    "output": "All tests passed"
                },
                "duration_seconds": 1.2,
                "usage": {"input_tokens": 500, "output_tokens": 150, "total_tokens": 650}
            }
        })

        result_line = json.dumps({
            "event": "result",
            "result": {
                "status": "SUCCESS",
                "response": "Done with testing",
                "usage": {"input_tokens": 500, "output_tokens": 150, "total_tokens": 650}
            }
        })

        fake_stdout = io.StringIO(f"{tool_active_line}\n{tool_done_line}\n{result_line}\n")

        with patch("antigravity_acp.server.send_notification", side_effect=fake_send_notification), \
             patch("antigravity_acp.server.send_response") as mock_response, \
             patch("antigravity_acp.server.shutil.which", return_value="/bin/agy"), \
             patch.dict("os.environ", {"PRAXIS_ANTIGRAVITY_UNSAFE_AUTO_APPROVE": "1"}), \
             patch("subprocess.Popen") as mock_popen:

            mock_proc = mock_popen.return_value
            mock_proc.stdout = fake_stdout
            mock_proc.wait.return_value = 0
            mock_proc.poll.return_value = 0

            session._run_turn("test prompt", 1)

            # Check that tool_call notification was sent
            tool_calls = [
                n[1] for n in notifications
                if n[1]["update"].get("sessionUpdate") == "tool_call"
            ]
            self.assertEqual(len(tool_calls), 1)
            self.assertEqual(tool_calls[0]["update"]["toolCallId"], "step-4")
            self.assertEqual(tool_calls[0]["update"]["name"], "run_command")
            self.assertEqual(tool_calls[0]["update"]["title"], "Run: npm test")
            self.assertEqual(tool_calls[0]["update"]["kind"], "execute")

            # Check that tool_call_update notification was sent
            tool_updates = [
                n[1] for n in notifications
                if n[1]["update"].get("sessionUpdate") == "tool_call_update"
            ]
            self.assertEqual(len(tool_updates), 1)
            self.assertEqual(tool_updates[0]["update"]["toolCallId"], "step-4")
            self.assertEqual(tool_updates[0]["update"]["status"], "completed")
            self.assertEqual(tool_updates[0]["update"]["rawOutput"], "All tests passed")

            # Check that in-flight usage_update notification was sent
            usage_updates = [
                n[1] for n in notifications
                if n[1]["update"].get("sessionUpdate") == "usage_update"
            ]
            self.assertEqual(len(usage_updates), 1)
            self.assertEqual(usage_updates[0]["update"]["used"], 650)
            self.assertEqual(
                usage_updates[0]["update"]["_meta"]["inFlightTokens"]["totalTokens"],
                650,
            )

            # Check final response
            mock_response.assert_called_once()
            res_arg = mock_response.call_args[0][1]
            self.assertEqual(res_arg["stopReason"], "end_turn")
            self.assertEqual(res_arg["usage"]["totalTokens"], 650)


if __name__ == "__main__":
    unittest.main()
