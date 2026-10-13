import ctypes
import json
import os
import platform
import subprocess
import sys
import threading

INTERVAL_SECONDS = 0.1
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")


class WindowsMemory:
    def __init__(self):
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
                (name, ctypes.c_size_t)
                for name in (
                    "PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage",
                    "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage",
                    "PagefileUsage", "PeakPagefileUsage",
                )
            ]

        self.counters = Counters
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.psapi = ctypes.WinDLL("psapi", use_last_error=True)
        self.kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.kernel.OpenProcess.restype = wintypes.HANDLE
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.CloseHandle.restype = wintypes.BOOL
        self.psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        self.psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
        self.handles = {}

    def read(self, pid):
        if pid not in self.handles:
            handle = self.kernel.OpenProcess(0x1000, False, pid)
            if not handle:
                return None, "OpenProcess:" + str(ctypes.get_last_error())
            self.handles[pid] = handle
        counters = self.counters()
        counters.cb = ctypes.sizeof(counters)
        if not self.psapi.GetProcessMemoryInfo(self.handles[pid], ctypes.byref(counters), counters.cb):
            return None, "GetProcessMemoryInfo:" + str(ctypes.get_last_error())
        if counters.WorkingSetSize <= 0:
            return None, "process-exited-or-empty-working-set"
        return {"rssBytes": int(counters.WorkingSetSize),
                "reportedLifetimePeakBytes": int(counters.PeakWorkingSetSize) or None}, None

    def close(self, pid):
        handle = self.handles.pop(pid, None)
        if handle:
            self.kernel.CloseHandle(handle)


class Sampler:
    def __init__(self):
        self.lock = threading.RLock()
        self.active = {}
        self.groups = {}
        self.stop_event = threading.Event()
        self.windows = WindowsMemory() if sys.platform == "win32" else None
        self.thread = threading.Thread(target=self.loop, daemon=True)
        self.thread.start()

    def read_many(self, pids):
        values = {}
        if self.windows:
            for pid in pids:
                values[pid] = self.windows.read(pid)
        elif sys.platform == "linux":
            for pid in pids:
                try:
                    with open(f"/proc/{pid}/status", encoding="utf-8") as stream:
                        lines = stream.readlines()
                    fields = {line.split(":", 1)[0]: line.split(":", 1)[1].strip() for line in lines if ":" in line}
                    rss = int(fields.get("VmRSS", "0 kB").split()[0]) * 1024
                    peak = int(fields.get("VmHWM", "0 kB").split()[0]) * 1024
                    values[pid] = ({"rssBytes": rss, "reportedLifetimePeakBytes": peak or None}, None) if rss > 0 else (None, "process-exited-or-empty-rss")
                except OSError as error:
                    values[pid] = (None, "proc-status:" + str(error.errno))
        elif sys.platform == "darwin":
            if not pids:
                return values
            try:
                result = subprocess.run(["ps", "-o", "pid=,rss=", "-p", ",".join(str(pid) for pid in pids)],
                                        capture_output=True, text=True, encoding="utf-8", timeout=1, check=False)
                if result.returncode not in (0, 1):
                    return {pid: (None, "ps-exit:" + str(result.returncode)) for pid in pids}
                for line in result.stdout.splitlines():
                    parts = line.split()
                    if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
                        values[int(parts[0])] = ({"rssBytes": int(parts[1]) * 1024,
                                                 "reportedLifetimePeakBytes": None}, None)
                for pid in pids:
                    values.setdefault(pid, (None, "process-not-present-in-ps"))
            except (OSError, subprocess.TimeoutExpired) as error:
                return {pid: (None, type(error).__name__) for pid in pids}
        else:
            return {pid: (None, "unsupported-platform") for pid in pids}
        return values

    def sample(self):
        values = self.read_many(list(self.active))
        group_rss = {}
        group_missing = {}
        for pid, record in self.active.items():
            value, error = values.get(pid, (None, "missing-read-result"))
            if value is None:
                record["lastUnavailableReason"] = error
                group_missing[record["group"]] = True
                continue
            record["samples"] += 1
            record["observedPeakRssBytes"] = max(record["observedPeakRssBytes"] or 0, value["rssBytes"])
            reported = value["reportedLifetimePeakBytes"]
            if reported is not None:
                record["reportedLifetimePeakBytes"] = max(record["reportedLifetimePeakBytes"] or 0, reported)
            group_rss[record["group"]] = group_rss.get(record["group"], 0) + value["rssBytes"]
        for group, total in group_rss.items():
            target = self.groups[group]
            target["samplingTicks"] += 1
            target["observedConcurrentPeakRssBytes"] = max(target["observedConcurrentPeakRssBytes"] or 0, total)
            if group_missing.get(group):
                target["partialTicks"] += 1

    def loop(self):
        while not self.stop_event.wait(INTERVAL_SECONDS):
            with self.lock:
                self.sample()

    def command(self, request):
        command = request["command"]
        group = request.get("group")
        pid = request.get("pid")
        with self.lock:
            if command == "begin":
                assert isinstance(group, str) and 0 < len(group) < 128 and group not in self.groups
                self.groups[group] = {"children": [], "samplingTicks": 0, "partialTicks": 0,
                                      "observedConcurrentPeakRssBytes": None}
                return {"started": True}
            if command == "watch":
                assert isinstance(pid, int) and pid > 0 and pid not in self.active and group in self.groups
                record = {"pid": pid, "group": group, "samples": 0, "observedPeakRssBytes": None,
                          "reportedLifetimePeakBytes": None, "lastUnavailableReason": None}
                self.active[pid] = record
                self.groups[group]["children"].append(record)
                self.sample()
                return {"watching": True}
            if command == "stop":
                assert isinstance(pid, int) and pid in self.active
                self.sample()
                record = self.active.pop(pid)
                if self.windows:
                    self.windows.close(pid)
                return {"stopped": True, "samples": record["samples"]}
            if command == "finish":
                assert group in self.groups and not any(record["group"] == group for record in self.active.values())
                result = self.groups.pop(group)
                for record in result["children"]:
                    record.pop("group")
                    record["missing"] = record["samples"] == 0
                result["missingChildren"] = sum(record["missing"] for record in result["children"])
                return result
            if command == "quit":
                assert not self.active and not self.groups
                return {"stopped": True}
            raise ValueError("unknown-command")

    def close(self):
        self.stop_event.set()
        self.thread.join(timeout=2)
        assert not self.thread.is_alive(), "sampler thread did not stop"
        if self.windows:
            for pid in list(self.windows.handles):
                self.windows.close(pid)


def output(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


sampler = Sampler()
prewarm_value, prewarm_error = sampler.read_many([os.getpid()])[os.getpid()]
if sampler.windows:
    sampler.windows.close(os.getpid())
output({"type": "ready", "platform": sys.platform, "pythonVersion": platform.python_version(),
        "samplingIntervalMs": int(INTERVAL_SECONDS * 1000),
        "prewarmSucceeded": prewarm_value is not None, "prewarmUnavailableReason": prewarm_error,
        "source": "GetProcessMemoryInfo" if os.name == "nt" else "/proc/status" if sys.platform == "linux" else "ps RSS"})
try:
    for line in sys.stdin:
        request = json.loads(line)
        assert isinstance(request.get("id"), int) and request["id"] > 0
        try:
            result = sampler.command(request)
            output({"id": request["id"], "result": result})
        except (AssertionError, KeyError, ValueError, OSError) as error:
            output({"id": request["id"], "error": type(error).__name__})
        if request.get("command") == "quit":
            break
finally:
    sampler.close()
