# ruff: noqa: ASYNC220, ASYNC221, ASYNC240
# A test harness, not a service: launching processes and touching files from async code is the point here.
"""End-to-end test of the EMETH Companion plugin on a real Paper server.

    cd mind && . .venv/bin/activate && python ../plugin/e2e/live_companion.py      (≈ 2–4 min, ~110 MB downloaded once)

What runs, all real: Paper 1.21.11 with the plugin jar (build it first: `cd plugin && ./gradlew build`), the EMETH body
(Mineflayer) as the player "Emeth", the mind in-process with a scripted brain (no LLM key), and a second Minecraft client,
"Micka", playing the human next to the agent (plugin/e2e/observer.mjs). Then the test checks, from Micka's client and from
the agent's own senses, what the interface really does:

  * the plugin reaches the mind (token never logged) and floats a text display on the agent — which the agent itself never
    perceives (honest perception);
  * `/emeth hud` → boss bar (goal, ladder), action bar (vitals), sidebar (mood, drives, thought);
  * `/emeth` → the "inside its head" window; clicking "whisper advice" then typing in chat delivers a `mentor_in` to the
    mind, kept out of the public chat; the agent answers in game at its next thought;
  * `/emeth goal`, console `emeth tell`, the mentor cooldown;
  * `/emeth monitor` → a map whose pixels are the agent's retina, received by Micka's client;
  * the mind going away is shown as such.
Exit code 0 only when every check passes.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
PLUGIN_DIR = ROOT / "plugin"
BODY_DIR = ROOT / "body"
MIND_DIR = ROOT / "mind"
CACHE = PLUGIN_DIR / "e2e" / ".cache"
sys.path.insert(0, str(MIND_DIR))

from emeth.config import LoopConfig, Settings  # noqa: E402
from emeth.llm.mock import MockProvider  # noqa: E402
from emeth.llm.router import LLMRouter  # noqa: E402
from emeth.llm.types import ChatRequest  # noqa: E402
from emeth.runtime import build_mind  # noqa: E402
from emeth.social.persona import Persona  # noqa: E402

PAPER = {
    "file": "paper-1.21.11-132.jar",
    "sha256": "5ffef465eeeb5f2a3c23a24419d97c51afd7dbb4923ff42df9a3f58bba1ccfba",
    "url": "https://fill-data.papermc.io/v1/objects/5ffef465eeeb5f2a3c23a24419d97c51afd7dbb4923ff42df9a3f58bba1ccfba/paper-1.21.11-132.jar",
}
COLOR = re.compile(r"§.")
ADVICE = "Va chercher du fer avant la nuit"
GOAL = "Construire un abri avant la nuit"


# --------------------------------------------------------------------------------------------------
def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def paper_jar() -> Path:
    jar = Path(os.environ["PAPER_JAR"]) if os.environ.get("PAPER_JAR") else CACHE / PAPER["file"]
    if not jar.exists():
        jar.parent.mkdir(parents=True, exist_ok=True)
        print(f"downloading {PAPER['file']} …", flush=True)
        # PaperMC's download service refuses generic clients (Python-urllib → 403): identify the project
        req = urllib.request.Request(PAPER["url"], headers={"User-Agent": "emeth-companion-e2e/0.1 (+https://github.com/Micka420-collab/Super_agent_mc)"})
        with urllib.request.urlopen(req, timeout=120) as resp, jar.open("wb") as fh:  # noqa: S310 - fixed https URL, checksum verified below
            shutil.copyfileobj(resp, fh)
    digest = hashlib.sha256(jar.read_bytes()).hexdigest()
    if digest != PAPER["sha256"]:
        raise SystemExit(f"{jar}: sha256 {digest} does not match the pinned Paper build")
    return jar


class Rcon:
    """Minimal Source RCON client (the protocol Minecraft speaks)."""

    def __init__(self, port: int, password: str):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=15)
        self.rid = 0
        self._send(3, password)
        if self._recv()[1] == -1:
            raise RuntimeError("rcon login refused")

    def _send(self, kind: int, body: str) -> None:
        self.rid += 1
        payload = struct.pack("<ii", self.rid, kind) + body.encode("utf-8") + b"\x00\x00"
        self.sock.sendall(struct.pack("<i", len(payload)) + payload)

    def _read(self, n: int) -> bytes:
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("rcon closed")
            buf += chunk
        return buf

    def _recv(self) -> tuple[int, int, str]:
        (size,) = struct.unpack("<i", self._read(4))
        data = self._read(size)
        rid, kind = struct.unpack("<ii", data[:8])
        return kind, rid, data[8:-2].decode("utf-8", "replace")

    def __call__(self, command: str) -> str:
        self._send(2, command)
        return COLOR.sub("", self._recv()[2])


class Observer:
    """The human next to the agent: a Mineflayer client driven over JSON lines."""

    def __init__(self, proc: asyncio.subprocess.Process):
        self.proc = proc

    @classmethod
    async def start(cls, port: int, name: str) -> Observer:
        proc = await asyncio.create_subprocess_exec("node", str(PLUGIN_DIR / "e2e" / "observer.mjs"), "127.0.0.1", str(port), name, str(BODY_DIR),
                                                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE)
        self = cls(proc)
        line = await self._line(60)
        if line.get("event") != "spawn":
            raise RuntimeError(f"observer did not spawn: {line}")
        return self

    async def _line(self, limit_s: float) -> dict[str, Any]:
        assert self.proc.stdout is not None
        while True:
            raw = await asyncio.wait_for(self.proc.stdout.readline(), limit_s)
            if not raw:
                raise RuntimeError("observer exited")
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                continue

    async def __call__(self, cmd: str, **args: Any) -> Any:
        assert self.proc.stdin is not None
        self.proc.stdin.write((json.dumps({"cmd": cmd, **args}) + "\n").encode())
        await self.proc.stdin.drain()
        while True:
            msg = await self._line(30)
            if "ok" in msg:
                if not msg["ok"]:
                    raise RuntimeError(f"observer {cmd}: {msg.get('error')}")
                return msg["result"]


def brain(req: ChatRequest) -> dict[str, Any]:
    user = req.messages[-1].content
    if req.purpose == "decision":
        if "[MENTOR]" in user and ADVICE in user:
            return {"reason": "Micka tells me to find iron before nightfall; it is sound advice, I will plan for it", "speech": "Merci Micka, je vais chercher du fer.",
                    "action": {"type": "none"}}
        if "Woke by: startup" in user:
            return {"reason": "I just woke up next to a friend; looking around before anything else", "speech": "Bonjour, je suis réveillé.",
                    "action": {"type": "primitive", "name": "find_blocks", "args": {"names": ["grass_block"], "maxDistance": 6, "count": 3}}}
        return {"reason": "nothing urgent, I watch and wait", "speech": None, "action": {"type": "wait", "seconds": 30, "for_what": "something to happen"}}
    if req.purpose == "critic":
        return {"success": False, "reasoning": "not yet", "critique": ""}
    return {"previously": "", "about_players": ""}


class Report:
    def __init__(self) -> None:
        self.rows: list[tuple[bool, str, str]] = []

    def check(self, ok: bool, name: str, detail: Any = "") -> bool:
        self.rows.append((bool(ok), name, str(detail)[:300]))
        print(("  ✔ " if ok else "  ✘ ") + name + ("" if ok else f"  ← {str(detail)[:300]}"), flush=True)
        return bool(ok)

    @property
    def failed(self) -> int:
        return sum(1 for ok, _, _ in self.rows if not ok)


async def until(predicate: Any, limit_s: float, every: float = 0.5) -> Any:
    deadline = time.monotonic() + limit_s
    last: Any = None
    while time.monotonic() < deadline:
        last = predicate()
        if asyncio.iscoroutine(last):
            last = await last
        if last:
            return last
        await asyncio.sleep(every)
    return last


def tail(path: Path, n: int = 40) -> str:
    try:
        return "\n".join(path.read_text(errors="replace").splitlines()[-n:])
    except OSError:
        return ""


# --------------------------------------------------------------------------------------------------
async def main() -> int:
    jar = sorted((PLUGIN_DIR / "build" / "libs").glob("emeth-companion-*.jar"))
    if not jar:
        raise SystemExit("build the plugin first: cd plugin && ./gradlew build")
    server_dir = CACHE / "server"
    (server_dir / "plugins").mkdir(parents=True, exist_ok=True)
    shutil.rmtree(server_dir / "plugins" / "EmethCompanion", ignore_errors=True)
    for old in (server_dir / "plugins").glob("emeth-companion-*.jar"):
        old.unlink()
    shutil.copy(jar[-1], server_dir / "plugins" / jar[-1].name)
    # every run starts with fresh players: the plugin remembers the HUD choice on the player, which must not leak between runs
    shutil.rmtree(server_dir / "world" / "playerdata", ignore_errors=True)

    mc_port, rcon_port, bridge_port, control_port = free_port(), free_port(), free_port(), free_port()
    token = "e2e-" + hashlib.sha1(str(time.time()).encode()).hexdigest()[:16]
    (server_dir / "eula.txt").write_text("eula=true\n")
    (server_dir / "server.properties").write_text("\n".join([
        "online-mode=false", f"server-port={mc_port}", "enable-rcon=true", f"rcon.port={rcon_port}", "rcon.password=e2e",
        "level-type=minecraft\\:flat", "generate-structures=false", "spawn-protection=0", "view-distance=4", "simulation-distance=4",
        "difficulty=peaceful", "gamemode=survival", "motd=EMETH companion e2e", "max-players=5", "enforce-secure-profile=false",
        "spawn-monsters=false", "spawn-animals=false", "allow-flight=true",
    ]) + "\n")
    cfg_dir = server_dir / "plugins" / "EmethCompanion"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    (cfg_dir / "config.yml").write_text(
        f'language: fr\nmind:\n  url: "ws://127.0.0.1:{control_port}"\n  token: "{token}"\n  poll-seconds: 1\n  timeout-seconds: 5\n'
        "hologram:\n  enabled: true\nhud:\n  default-on-join: false\nmonitor:\n  refresh-seconds: 1\n"
        "announce:\n  kinds: [achievement, death]\n  audience: followers\n  stuck-alert: true\nmentor:\n  cooldown-seconds: 30\n  max-length: 600\n")

    report = Report()
    log_path = server_dir / "e2e-server.log"
    procs: list[subprocess.Popen[bytes]] = []
    paper: subprocess.Popen[bytes] | None = None
    observer: Observer | None = None
    mind = None
    loop_task: asyncio.Task[Any] | None = None
    try:
        print(f"Paper on :{mc_port} (rcon :{rcon_port}), body bridge :{bridge_port}, mind control :{control_port}", flush=True)
        log = log_path.open("wb")
        paper = subprocess.Popen(["java", "-Xms1G", "-Xmx2G", "-jar", str(paper_jar()), "--nogui"], cwd=server_dir, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        procs.append(paper)
        done = await until(lambda: "Done (" in log_path.read_text(errors="replace") or paper.poll() is not None, 420, 1)
        if paper.poll() is not None or not done:
            print(tail(log_path, 60))
            raise SystemExit("Paper did not start")
        server_log = log_path.read_text(errors="replace")
        report.check("Enabling EmethCompanion" in server_log, "Paper loads the plugin")
        report.check(f"watching the mind at ws://127.0.0.1:{control_port}/?token=***" in server_log and token not in server_log, "the plugin targets the mind and never logs the token")
        rcon = Rcon(rcon_port, "e2e")

        body_env = {**os.environ, "MC_HOST": "127.0.0.1", "MC_PORT": str(mc_port), "MC_USERNAME": "Emeth", "BRIDGE_PORT": str(bridge_port),
                    "BRIDGE_TOKEN": "e2e-bridge", "LOG_LEVEL": "warn", "MC_HONEST_PERCEPTION": "false"}
        # own process group: `npx tsx` forks a node child that a plain terminate() would orphan
        body = subprocess.Popen(["npx", "tsx", "src/index.ts"], cwd=BODY_DIR, env=body_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        procs.append(body)

        def bridge_up() -> bool:
            with contextlib.suppress(OSError), socket.create_connection(("127.0.0.1", bridge_port), timeout=1):
                return True
            return False

        if not await until(bridge_up, 90, 1):
            raise SystemExit("the body's bridge never came up")
        await until(lambda: "Emeth joined the game" in log_path.read_text(errors="replace"), 60, 1)

        tmp = Path(tempfile.mkdtemp(prefix="emeth-e2e-"))
        settings = Settings(data_dir=tmp / "data", skills_dir=tmp / "skills", bridge_url=f"ws://127.0.0.1:{bridge_port}", bridge_token="e2e-bridge",
                            control_port=control_port, control_token=token, loop=LoopConfig(memory_rewrite_every_events=999, idle_body_min_s=60, idle_body_max_s=90))
        router = LLMRouter([MockProvider("brain", script=brain)], max_requests_per_minute=1000)
        mind = build_mind(settings, router=router, persona=Persona(name="Emeth", owner="Micka"))
        loop = await mind.start()
        loop_task = asyncio.create_task(loop.run())
        rcon("emeth reload")  # skip the plugin's reconnection backoff: it has been retrying since the server started

        online = await until(lambda: "online" in rcon("emeth status").splitlines()[0], 30, 1)
        report.check(online, "the plugin reaches the running mind", rcon("emeth status"))
        report.check("connected to the mind of Emeth" in log_path.read_text(errors="replace"), "the plugin logs the connection")
        status = await until(lambda: (s := rcon("emeth status")) and "hologram attached to Emeth" in s and s, 30, 1)
        report.check(status, "a hologram rides the agent", status or rcon("emeth status"))
        report.check("Test passed" in rcon("execute if entity @e[type=minecraft:text_display]"), "the text display exists in the world")
        await until(lambda: loop.stats.decisions >= 1, 30, 0.5)
        report.check("Thought" in rcon("emeth status") or "Pensée" in rcon("emeth status"), "the agent's thought is readable from the console", rcon("emeth status"))

        # the agent's own senses: the interface is for humans, never part of the agent's perception
        obs = await mind.body.observe("full")
        names = [e.name for bucket in (obs.entities.players, obs.entities.hostiles, obs.entities.passives, obs.entities.items, obs.entities.other) for e in bucket]
        report.check("text_display" not in names, "the agent does not perceive its own hologram", names)

        # --- the human next to it -------------------------------------------------------------
        observer = await Observer.start(mc_port, "Micka")
        rcon("op Micka")
        await asyncio.sleep(1.5)
        snap = await observer("snapshot")
        holo = [e for e in snap["entities"] if e["name"] == "text_display"]
        report.check(holo and holo[0]["vehicle"] == "Emeth", "Micka sees the card floating above Emeth", snap["entities"])

        await observer("chat", text="/emeth hud")
        report.check(await until(_chat_contains(observer, "Affichage d'Emeth activé"), 10, 0.5), "/emeth hud turns the display on for a newcomer")
        snap = await until(_has_hud(observer), 15, 1)
        if not snap:
            raw = await observer("snapshot")
            print("    HUD seen by Micka:", json.dumps({k: raw[k] for k in ("bossBars", "actionBar", "sidebar")}, ensure_ascii=False)[:1500], "| chat:", raw["chat"][-4:], flush=True)
        report.check(snap and any("Emeth" in b["title"] and "But" in b["title"] for b in snap["bossBars"]), "boss bar: agent, goal and ladder", snap and snap["bossBars"])
        report.check(snap and "❤" in snap["actionBar"], "action bar: the agent's vitals", snap and snap["actionBar"])
        side = snap["sidebar"] if snap else None
        lines = [i["display"] for i in side["items"]] if side else []
        report.check(side and "EMETH" in side["title"] and any("Humeur" in line for line in lines) and any("Danger" in line for line in lines),
                     "sidebar: mood, drives and odds inside the agent's head", side)

        await observer("chat", text="/emeth")
        snap = await until(_window_open(observer), 10, 0.5)
        window = snap["window"] if snap else None
        report.check(window and "Dans la tête de Emeth" in window["title"], "/emeth opens the 'inside its head' window", window and window["title"])
        slots = {s["slot"]: s for s in window["slots"]} if window else {}
        report.check(slots.get(4, {}).get("name") == "player_head" and slots.get(38, {}).get("name") == "feather" and slots.get(23) is not None,
                     "the window shows the agent, its odds and the mentor's feather", {k: slots[k]["name"] for k in sorted(slots)[:60] if k in (4, 19, 21, 23, 25, 38, 40)})

        await observer("click", slot=38, button=0)
        prompt = await until(_chat_contains(observer, "conseil pour Emeth"), 10, 0.5)
        report.check(prompt, "clicking the feather asks for advice in chat")
        await observer("chat", text=ADVICE)
        heard = await until(lambda: [e for e in mind.timeline.entries if e.kind == "mentor_in" and ADVICE in e.text], 15, 0.5)
        report.check(heard and "Micka (in game)" in heard[0].text, "the advice reaches the mind as mentor_in, signed by Micka", heard and heard[0].text)
        body_chat = [c.text for c in (await mind.body.observe("compact")).chat]
        report.check(not any(ADVICE in c for c in body_chat), "the advice stayed out of the public chat", body_chat)
        answer = await until(_chat_contains(observer, "Merci Micka, je vais chercher du fer"), 30, 1)
        report.check(answer, "the agent weighs it and answers in game at its next thought")

        await observer("chat", text="/emeth tell encore un conseil")
        cooled = await until(_chat_contains(observer, "Doucement"), 10, 0.5)
        report.check(cooled, "a second advice right away hits the mentor cooldown")

        rcon("emeth goal " + GOAL)
        goal = await until(lambda: [g for g in mind.planner.goals if g.title == GOAL and g.status == "active"], 10, 0.5)
        report.check(goal, "`emeth goal` from the console proposes a goal to the agent", [g.title for g in mind.planner.goals])
        rcon("emeth tell La console te salue")
        told = await until(lambda: [e for e in mind.timeline.entries if e.kind == "mentor_in" and "La console te salue" in e.text], 10, 0.5)
        report.check(told and "(console)" in told[0].text, "console advice is signed as such", told and told[0].text)

        await observer("chat", text="/emeth monitor")
        got = await until(lambda: _inventory_has(observer, "filled_map"), 10, 0.5)
        report.check(got, "/emeth monitor gives a retina map")
        await observer("equipMap")
        await observer("lookAt", username="Emeth")
        maps = await until(_retina_pixels(observer), 25, 1)
        report.check(maps, "the map carries the agent's retina (many colours, full 128×128)", maps or (await observer("snapshot"))["maps"])

        capture = os.environ.get("EMETH_E2E_CAPTURE")
        if capture:
            await stage_and_capture(Path(capture), rcon, mind, control_port, token)

        # the HUD choice is remembered on the player: a reconnection brings it back without a command
        await observer("quit")
        await asyncio.sleep(1.5)
        observer = await Observer.start(mc_port, "Micka")
        back = await until(_has_hud(observer), 15, 1)
        report.check(back, "the HUD comes back by itself when Micka reconnects")

        # --- the mind goes away -----------------------------------------------------------------
        if loop_task:
            loop_task.cancel()
        await mind.close()
        mind = None
        offline = await until(lambda: rcon("emeth status").splitlines()[0].find("offline") >= 0, 30, 1)
        report.check(offline, "the plugin notices the mind is gone", rcon("emeth status"))
        gone = await until(_boss_title_contains(observer, "esprit injoignable"), 40, 1)
        last = await observer("snapshot")
        report.check(gone, "followers see the mind is unreachable", {"bars": last["bossBars"], "log": last["bossLog"]})
        after_start = log_path.read_text(errors="replace").split("Done (", 1)[-1]
        crashes = [line for line in after_start.splitlines() if "at dev.emeth" in line or "Could not pass event" in line or "Unhandled exception" in line
                   or ("[EmethCompanion]" in line and "SEVERE" in line)]
        report.check(not crashes, "no plugin stack trace in the server log", crashes[:5])
        rcon("stop")
    finally:
        if observer is not None:
            with contextlib.suppress(Exception):
                await observer("quit")
        if loop_task:
            loop_task.cancel()
        if mind is not None:
            with contextlib.suppress(Exception):
                await mind.close()
        for p in reversed(procs):
            with contextlib.suppress(Exception):
                if p.poll() is None:
                    if p is paper:
                        p.terminate()
                    else:
                        os.killpg(p.pid, signal.SIGTERM)
                p.wait(30)
    print(f"\n{len(report.rows) - report.failed}/{len(report.rows)} checks passed", flush=True)
    if report.failed:
        print("--- server log tail ---\n" + tail(log_path, 40))
    return 1 if report.failed else 0


async def run_node(args: list[str]) -> None:
    proc = await asyncio.create_subprocess_exec(*args, cwd=PLUGIN_DIR / "e2e")
    if await proc.wait() != 0:
        raise RuntimeError(f"{' '.join(args[:3])} failed")


async def stage_and_capture(out: Path, rcon: Rcon, mind: Any, control_port: int, token: str) -> None:
    """Documentation captures (EMETH_E2E_CAPTURE=<dir>): a small scene staged from the console in front of the agent, its
    real retina render, and a screenshot of the real dashboard of this running mind. Nothing here is drawn by hand."""
    out.mkdir(parents=True, exist_ok=True)
    obs = await mind.body.observe("compact")
    x, y, z = (int(v // 1) for v in (obs.self_.position.x, obs.self_.position.y, obs.self_.position.z))
    await mind.body.act("look_at", {"x": x + 0.5, "y": y + 2.5, "z": z - 20})  # face north, towards the scene
    for cmd in [
        "time set 6000", "weather clear",
        f"fill {x - 3} {y} {z - 20} {x + 3} {y + 3} {z - 14} minecraft:cobblestone hollow",
        *[f"fill {cx} {y} {cz} {cx} {y + 3} {cz} minecraft:oak_log" for cx in (x - 3, x + 3) for cz in (z - 12, z - 6)],
        f"fill {x} {y} {z - 14} {x} {y + 1} {z - 14} minecraft:air",
        f"setblock {x - 2} {y + 1} {z - 14} minecraft:glass", f"setblock {x + 2} {y + 1} {z - 14} minecraft:glass",
        f"fill {x - 4} {y + 4} {z - 21} {x + 4} {y + 4} {z - 13} minecraft:spruce_planks",
        f"fill {x - 3} {y + 5} {z - 20} {x + 3} {y + 5} {z - 14} minecraft:spruce_planks",
        f"fill {x - 1} {y + 6} {z - 19} {x + 1} {y + 6} {z - 15} minecraft:spruce_planks",
        f"setblock {x + 1} {y} {z - 13} minecraft:lantern",
        *[f"fill {tx} {y} {z - 12} {tx} {y + 4} {z - 12} minecraft:oak_log" for tx in (x - 8, x + 8)],
        *[f"fill {tx - 2} {y + 3} {z - 14} {tx + 2} {y + 5} {z - 10} minecraft:oak_leaves keep" for tx in (x - 8, x + 8)],
        f"fill {x + 5} {y - 1} {z - 20} {x + 7} {y - 1} {z - 17} minecraft:water",
        f"fill {x - 7} {y - 1} {z - 20} {x - 5} {y - 1} {z - 18} minecraft:sand",
        f"setblock {x - 6} {y} {z - 19} minecraft:iron_ore",
    ]:
        rcon(cmd)
    await asyncio.sleep(2)
    frame = await mind.body.render(width=256, height=144, fov_deg=110)
    raw = out / "retina-raw.png"
    raw.write_bytes(base64.b64decode(frame.pngBase64))
    node = ["node", str(PLUGIN_DIR / "e2e" / "capture.mjs")]
    await run_node([*node, "upscale", str(raw), str(out / "retina.png"), "4"])
    raw.unlink()
    await mind.loop.think("visitor")  # a fresh thought so the dashboard has something to show
    # async on purpose: the mind serving this dashboard runs in this very event loop
    await run_node([*node, "page", f"http://127.0.0.1:{control_port}/?token={token}", str(out / "dashboard.png"), "1280", "860"])
    print(f"    captures written to {out}: retina.png ({frame.width}x{frame.height} ×4), dashboard.png", flush=True)


def _has_hud(observer: Observer) -> Any:
    async def check() -> Any:
        snap = await observer("snapshot")
        return snap if snap["bossBars"] and snap["actionBar"] and snap["sidebar"] and snap["sidebar"]["items"] else None
    return check


def _window_open(observer: Observer) -> Any:
    async def check() -> Any:
        snap = await observer("snapshot")
        return snap if snap["window"] else None
    return check


def _chat_contains(observer: Observer, needle: str) -> Any:
    async def check() -> bool:
        return any(needle in line for line in (await observer("snapshot"))["chat"])
    return check


def _boss_title_contains(observer: Observer, needle: str) -> Any:
    async def check() -> bool:
        return any(needle in b["title"] for b in (await observer("snapshot"))["bossBars"])
    return check


async def _inventory_has(observer: Observer, name: str) -> bool:
    return any(i and i["name"] == name for i in (await observer("snapshot"))["inventory"])


def _retina_pixels(observer: Observer) -> Any:
    async def check() -> Any:
        maps = (await observer("snapshot"))["maps"]
        good = [m for m in maps if m["columns"] == 128 and m["rows"] == 128 and m["distinct"] >= 4]
        return good or None
    return check


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
