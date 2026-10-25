"""Bounded, read-only backend birth checks for evaluation lifecycle hooks."""
import asyncio


async def backend_identity(environment, backend, delays=(0.5, 1)):
    errors = []
    for attempt in range(3):
        try:
            # Official timeout cleanup may remove an already admitted backend before AGENT_END.
            result = await environment.exec(
                f"start=$(awk '{{print $22}}' /proc/{backend['pid']}/stat 2>/dev/null) && "
                "{ printf '%s\\n' \"$start\"; exit 0; }; "
                f"if [ ! -d /proc/{backend['pid']} ]; then printf 'ZAOVRA_BACKEND_ENDED\\n'; exit 3; fi; exit 2", timeout_sec=5)
        except (RuntimeError, OSError, TimeoutError) as error:
            errors.append({"attempt": attempt + 1, "type": type(error).__name__, "message": str(error)})
            if attempt < 2:
                await asyncio.sleep(delays[attempt])
            continue
        ended = result.return_code == 3 and result.stdout.strip() == "ZAOVRA_BACKEND_ENDED"
        return {"verified": None if ended else result.return_code == 0 and result.stdout.strip() == backend["start"],
                "ended": ended, "facility_failure": False, "attempts": attempt + 1, "errors": errors,
                "pid": backend["pid"], "expected_start": backend["start"],
                "observed_start": result.stdout.strip(), "return_code": result.return_code}
    return {"verified": None, "ended": False, "facility_failure": True, "attempts": 3, "errors": errors,
            "pid": backend["pid"], "expected_start": backend["start"]}
