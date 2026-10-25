import asyncio
import unittest
from types import SimpleNamespace
from evaluation_probe import backend_identity


class ProbeTests(unittest.IsolatedAsyncioTestCase):
    async def test_ended_backend_is_observed_without_claiming_live_identity(self):
        class Environment:
            async def exec(self, command, **kwargs):
                return SimpleNamespace(return_code=3, stdout="ZAOVRA_BACKEND_ENDED\n")
        result = await backend_identity(Environment(), {"pid": 48, "start": "19101989"}, (0, 0))
        self.assertIsNone(result["verified"])
        self.assertTrue(result["ended"])
        self.assertFalse(result["facility_failure"])
        self.assertEqual(result["attempts"], 1)

    async def test_unrecognized_error_cannot_claim_backend_ended(self):
        class Environment:
            async def exec(self, command, **kwargs):
                return SimpleNamespace(return_code=2, stdout="permission denied\n")
        result = await backend_identity(Environment(), {"pid": 48, "start": "19101989"}, (0, 0))
        self.assertFalse(result["verified"])
        self.assertFalse(result["ended"])

    async def test_transient_timeout_recovers_with_exact_identity(self):
        calls = []
        class Environment:
            async def exec(self, command, **kwargs):
                calls.append((command, kwargs))
                if len(calls) == 1:
                    raise RuntimeError("Compose exec timed out")
                return SimpleNamespace(return_code=0, stdout="456\n")
        result = await backend_identity(Environment(), {"pid": 123, "start": "456"}, (0, 0))
        self.assertTrue(result["verified"])
        self.assertFalse(result["facility_failure"])
        self.assertEqual(result["attempts"], 2)
        command = "start=$(awk '{print $22}' /proc/123/stat 2>/dev/null) && { printf '%s\\n' \"$start\"; exit 0; }; if [ ! -d /proc/123 ]; then printf 'ZAOVRA_BACKEND_ENDED\\n'; exit 3; fi; exit 2"
        self.assertTrue(all(call == (command, {"timeout_sec": 5}) for call in calls))

    async def test_exhausted_transport_is_unverified_facility_failure(self):
        calls = []
        class Environment:
            async def exec(self, command, **kwargs):
                calls.append(command)
                raise RuntimeError("Compose exec timed out")
        result = await backend_identity(Environment(), {"pid": 123, "start": "456"}, (0, 0))
        self.assertIsNone(result["verified"])
        self.assertTrue(result["facility_failure"])
        self.assertEqual(len(calls), 3)
        self.assertEqual(len(result["errors"]), 3)

    async def test_reused_pid_remains_a_definitive_mismatch(self):
        class Environment:
            async def exec(self, command, **kwargs):
                return SimpleNamespace(return_code=0, stdout="different-birth\n")
        result = await backend_identity(Environment(), {"pid": 123, "start": "456"}, (0, 0))
        self.assertFalse(result["verified"])
        self.assertFalse(result["facility_failure"])
        self.assertEqual(result["attempts"], 1)

    async def test_cancellation_does_not_retry(self):
        class Environment:
            async def exec(self, command, **kwargs):
                raise asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await backend_identity(Environment(), {"pid": 123, "start": "456"}, (0, 0))
