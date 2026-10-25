"""Bounded, read-only backend birth checks for evaluation lifecycle hooks."""
import asyncio


async def backend_identity(environment, backend, delays=(0.5, 1)):
    errors = []
    for attempt in range(3):
        try:
            result = await environment.exec(f"awk '{{print $22}}' /proc/{backend['pid']}/stat", timeout_sec=5)
        except (RuntimeError, OSError, TimeoutError) as error:
            errors.append({"attempt": attempt + 1, "type": type(error).__name__, "message": str(error)})
            if attempt < 2:
                await asyncio.sleep(delays[attempt])
            continue
        return {"verified": result.return_code == 0 and result.stdout.strip() == backend["start"],
                "facility_failure": False, "attempts": attempt + 1, "errors": errors,
                "pid": backend["pid"], "expected_start": backend["start"],
                "observed_start": result.stdout.strip(), "return_code": result.return_code}
    return {"verified": None, "facility_failure": True, "attempts": 3, "errors": errors,
            "pid": backend["pid"], "expected_start": backend["start"]}
