"""Evaluation-only Windows process owner. JSON stdin controls one suspended-first Job.

Run under the outer evaluation resource supervisor. This owns processes, not Session
completion: an empty Job after stop must never turn an unfinished Session into success.
Child stdout/stderr go only to the caller's new log; control replies contain no command,
environment, request body, or child output. No breakaway flags are enabled.
"""
import argparse
import ctypes
from ctypes import wintypes
import json
import msvcrt
import os
import queue
import subprocess
import sys
import threading
import time
import uuid
import _winapi


class Basic(ctypes.Structure):
    _fields_ = [("processTime", ctypes.c_longlong), ("jobTime", ctypes.c_longlong),
                ("flags", wintypes.DWORD), ("minWS", ctypes.c_size_t),
                ("maxWS", ctypes.c_size_t), ("activeLimit", wintypes.DWORD),
                ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD),
                ("scheduling", wintypes.DWORD)]


class IO(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in
                ["readOp", "writeOp", "otherOp", "readBytes", "writeBytes", "otherBytes"]]


class Limits(ctypes.Structure):
    _fields_ = [("basic", Basic), ("io", IO), ("processMemory", ctypes.c_size_t),
                ("jobMemory", ctypes.c_size_t), ("peakProcess", ctypes.c_size_t),
                ("peakJob", ctypes.c_size_t)]


def run():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--log", required=True)
    parser.add_argument("--seconds", type=int, default=900)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command or not os.path.isabs(args.cwd) or not os.path.isabs(args.log) or not 1 <= args.seconds <= 3600:
        raise ValueError("invalid-host-launch")
    native = ctypes.WinDLL("kernel32", use_last_error=True)
    native.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    native.CreateJobObjectW.restype = wintypes.HANDLE
    native.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    native.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
    native.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    native.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    native.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    native.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    native.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    native.ResumeThread.argtypes = [wintypes.HANDLE]
    native.ResumeThread.restype = wintypes.DWORD
    native.CloseHandle.argtypes = [wintypes.HANDLE]

    def check(value):
        if not value:
            raise ctypes.WinError(ctypes.get_last_error())
        return value

    scope = str(uuid.uuid4())
    job = check(native.CreateJobObjectW(None, None))
    process = thread = None
    try:
        limits = Limits()
        limits.basic.flags = 0x2000 | 0x10  # kill-on-close and two logical CPUs; no breakaway
        limits.basic.affinity = 3
        check(native.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)))

        def members():
            buffer = ctypes.create_string_buffer(65536)
            check(native.QueryInformationJobObject(job, 3, buffer, len(buffer), None))
            count = ctypes.c_uint32.from_buffer(buffer, 4).value
            if count > (len(buffer) - 8) // ctypes.sizeof(ctypes.c_size_t):
                raise ValueError("job-member-cap")
            return list((ctypes.c_size_t * count).from_buffer(buffer, 8))

        def emit(event, nonce=None, **data):
            print(json.dumps({"event": event, "scope": scope, "nonce": nonce, **data}), flush=True)

        def stop(reason, nonce=None):
            check(native.TerminateJobObject(job, 143))
            deadline = time.monotonic() + 15
            while members() and time.monotonic() < deadline:
                time.sleep(0.02)
            remaining = members()
            if native.WaitForSingleObject(int(process), 15000) != 0:
                raise RuntimeError("root-exit-not-confirmed")
            code = wintypes.DWORD()
            check(native.GetExitCodeProcess(int(process), ctypes.byref(code)))
            emit("stopped", nonce, reason=reason, remaining=remaining, rootExit=code.value)
            if remaining:
                raise RuntimeError("job-members-remain")

        with open(args.log, "xb") as log, open(os.devnull, "rb") as null:
            output = msvcrt.get_osfhandle(log.fileno())
            stdin = msvcrt.get_osfhandle(null.fileno())
            os.set_handle_inheritable(output, True)
            os.set_handle_inheritable(stdin, True)
            startup = subprocess.STARTUPINFO()
            startup.dwFlags = subprocess.STARTF_USESTDHANDLES
            startup.hStdInput = stdin
            startup.hStdOutput = startup.hStdError = output
            startup.lpAttributeList = {"handle_list": [stdin, output]}
            process, thread, pid, _ = _winapi.CreateProcess(
                None, subprocess.list2cmdline(command), None, None, True,
                subprocess.CREATE_NO_WINDOW | 4, dict(os.environ), args.cwd, startup)
            check(native.AssignProcessToJobObject(job, int(process)))
            if native.ResumeThread(int(thread)) == 0xFFFFFFFF:
                raise ctypes.WinError(ctypes.get_last_error())
            native.CloseHandle(int(thread))
            thread = None
            emit("started", pid=pid, assignedBeforeResume=True, killOnClose=True)
            requests = queue.Queue(maxsize=16)

            def read():
                while True:
                    # A daemon must not hold Python's buffered-stdin lock at interpreter exit.
                    line = bytearray()
                    while len(line) <= 4096:
                        part = os.read(sys.stdin.fileno(), 1)
                        if not part:
                            break
                        line.extend(part)
                        if part == b"\n":
                            break
                    if not line:
                        requests.put({"op": "eof"})
                        return
                    try:
                        item = json.loads(line) if len(line) <= 4096 else None
                    except (ValueError, UnicodeError):
                        item = None
                    requests.put(item)
                    if item is None:
                        return

            threading.Thread(target=read, daemon=True).start()
            deadline = time.monotonic() + args.seconds
            while True:
                if time.monotonic() >= deadline:
                    stop("deadline")
                    return
                try:
                    item = requests.get(timeout=0.1)
                except queue.Empty:
                    continue
                if not isinstance(item, dict) or item.get("op") not in ["inspect", "stop", "eof"]:
                    stop("invalid-control")
                    return
                nonce = item.get("nonce")
                if nonce is not None and (not isinstance(nonce, str) or len(nonce) > 128):
                    stop("invalid-nonce")
                    return
                if item["op"] != "inspect":
                    stop("requested" if item["op"] == "stop" else "control-closed", nonce)
                    return
                state = native.WaitForSingleObject(int(process), 0)
                if state not in [0, 258]:
                    raise ctypes.WinError(ctypes.get_last_error())
                emit("inspection", nonce, pid=pid, rootAlive=state == 258, members=members())
    finally:
        native.TerminateJobObject(job, 143)
        # Also owns a suspended child if assignment itself failed; never kill by a rediscovered PID.
        if process and native.WaitForSingleObject(int(process), 0) == 258:
            native.TerminateProcess(int(process), 143)
        if thread:
            native.CloseHandle(int(thread))
        if process:
            native.WaitForSingleObject(int(process), 15000)
            native.CloseHandle(int(process))
        native.CloseHandle(job)


if __name__ == "__main__":
    try:
        run()
    except Exception as error:
        # Never serialize arbitrary child arguments, paths, environment, or exception text.
        print(json.dumps({"event": "failed", "reason": type(error).__name__,
                          "winerror": getattr(error, "winerror", None)}), flush=True)
        sys.exit(1)
