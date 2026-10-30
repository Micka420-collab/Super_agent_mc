"""Spatial memory — a world knowledge graph (graphify-style schema) built from what the agent sees.

Nodes: places, resource veins, structures, players, hazards, routes. Edges carry a relation and a
confidence (`EXTRACTED` = observed directly, `INFERRED` = deduced, `AMBIGUOUS` = hearsay from chat).
Communities (Louvain, deterministic seed) become named *regions*, and `query()` is a token-budgeted
BFS so the mind can recall "what do I know around here?" cheaply.
"""

from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import networkx as nx

from emeth.protocol import Observation

RESOURCE_BLOCKS = {
    "coal_ore", "deepslate_coal_ore", "iron_ore", "deepslate_iron_ore", "copper_ore", "deepslate_copper_ore", "gold_ore", "deepslate_gold_ore",
    "redstone_ore", "deepslate_redstone_ore", "lapis_ore", "deepslate_lapis_ore", "diamond_ore", "deepslate_diamond_ore", "emerald_ore", "deepslate_emerald_ore",
    "ancient_debris", "nether_quartz_ore", "nether_gold_ore",
}
STRUCTURE_BLOCKS = {"chest", "trapped_chest", "barrel", "crafting_table", "furnace", "blast_furnace", "smoker", "bell", "lectern", "enchanting_table", "anvil", "spawner", "trial_spawner", "nether_portal", "end_portal_frame", "beehive", "bee_nest", "campfire"}
HAZARD_BLOCKS = {"lava", "fire", "magma_block", "sweet_berry_bush", "cactus", "pointed_dripstone"}
WATER_BLOCKS = {"water"}
CELL = 8  # blocks per spatial cell for de-duplication


@dataclass
class GraphNode:
    id: str
    kind: str
    label: str
    dim: str
    x: float
    y: float
    z: float
    confidence: str = "EXTRACTED"
    first_seen: float = 0.0
    last_seen: float = 0.0
    count: int = 1
    notes: str = ""


def cell_of(x: float, y: float, z: float) -> tuple[int, int, int]:
    return (math.floor(x / CELL), math.floor(y / CELL), math.floor(z / CELL))


class WorldGraph:
    def __init__(self, path: Path | None = None):
        self.g = nx.Graph()
        self.g.graph.update({"schema_version": 1, "generator": "emeth", "hyperedges": []})
        self.path = Path(path) if path else None
        self._region_labels: dict[int, str] = {}
        if self.path and self.path.exists():
            self.load()

    # ---- persistence (graphify node_link format) --------------------------------------------
    def save(self) -> None:
        if not self.path:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = nx.node_link_data(self.g, edges="links")
        data["region_labels"] = {str(k): v for k, v in self._region_labels.items()}
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.path)

    def load(self) -> None:
        assert self.path is not None
        data = json.loads(self.path.read_text(encoding="utf-8"))
        labels = data.pop("region_labels", {})
        self.g = nx.node_link_graph(data, edges="links")
        self._region_labels = {int(k): v for k, v in labels.items()}

    # ---- mutation --------------------------------------------------------------------------
    def add_node(self, kind: str, label: str, x: float, y: float, z: float, *, dim: str = "overworld", confidence: str = "EXTRACTED", notes: str = "", node_id: str | None = None) -> str:
        now = time.time()
        nid = node_id or f"{kind}:{label}:{dim}:{'/'.join(map(str, cell_of(x, y, z)))}"
        if nid in self.g:
            n = self.g.nodes[nid]
            n["last_seen"] = now
            n["count"] = n.get("count", 1) + 1
            # keep the first observed coordinates unless this is a named place being updated
            if kind == "place":
                n.update({"x": x, "y": y, "z": z})
            if notes:
                n["notes"] = notes
            return nid
        self.g.add_node(nid, kind=kind, label=label, dim=dim, x=x, y=y, z=z, confidence=confidence, first_seen=now, last_seen=now, count=1, notes=notes, file_type=kind)
        self._link_neighbours(nid)
        return nid

    def add_edge(self, a: str, b: str, relation: str, *, confidence: str = "EXTRACTED", weight: float = 1.0) -> None:
        if a == b or a not in self.g or b not in self.g:
            return
        self.g.add_edge(a, b, relation=relation, confidence=confidence, weight=weight)

    def _link_neighbours(self, nid: str, radius: float = 24.0) -> None:
        n = self.g.nodes[nid]
        for other, attrs in self.g.nodes(data=True):
            if other == nid or attrs.get("dim") != n["dim"]:
                continue
            d = math.dist((n["x"], n["y"], n["z"]), (attrs["x"], attrs["y"], attrs["z"]))
            if d <= radius:
                self.g.add_edge(nid, other, relation="near", confidence="EXTRACTED", weight=round(d, 1))

    def mark_place(self, name: str, x: float, y: float, z: float, *, kind: str = "place", dim: str = "overworld", notes: str = "") -> str:
        return self.add_node(kind, name, x, y, z, dim=dim, notes=notes, node_id=f"place:{name}:{dim}")

    def observe(self, obs: Observation) -> list[str]:
        """Ingest notable blocks, visible players and hazards from an observation. Returns new node ids."""
        new: list[str] = []
        dim = obs.self_.dimension
        before = set(self.g.nodes)
        for b in obs.blocks.notable:
            kind = "resource" if b.name in RESOURCE_BLOCKS else "structure" if b.name in STRUCTURE_BLOCKS else "hazard" if b.name in HAZARD_BLOCKS else "water" if b.name in WATER_BLOCKS else None
            if kind is None:
                continue
            self.add_node(kind, b.name, b.position.x, b.position.y, b.position.z, dim=dim)
        for p in obs.entities.players:
            if p.username:
                nid = self.add_node("player", p.username, p.position.x, p.position.y, p.position.z, dim=dim, node_id=f"player:{p.username}")
                self.g.nodes[nid].update({"x": p.position.x, "y": p.position.y, "z": p.position.z})
        new = [n for n in self.g.nodes if n not in before]
        return new

    # ---- queries ---------------------------------------------------------------------------
    def nodes_of(self, kind: str | None = None, dim: str | None = None) -> list[GraphNode]:
        out = []
        for nid, a in self.g.nodes(data=True):
            if kind and a.get("kind") != kind:
                continue
            if dim and a.get("dim") != dim:
                continue
            out.append(GraphNode(id=nid, kind=a["kind"], label=a["label"], dim=a["dim"], x=a["x"], y=a["y"], z=a["z"], confidence=a.get("confidence", "EXTRACTED"), first_seen=a.get("first_seen", 0), last_seen=a.get("last_seen", 0), count=a.get("count", 1), notes=a.get("notes", "")))
        return out

    def nearest(self, x: float, y: float, z: float, *, kind: str | None = None, label: str | None = None, dim: str = "overworld", limit: int = 5) -> list[tuple[GraphNode, float]]:
        rows: list[tuple[GraphNode, float]] = []
        for n in self.nodes_of(kind, dim):
            if label and label not in n.label:
                continue
            rows.append((n, math.dist((x, y, z), (n.x, n.y, n.z))))
        rows.sort(key=lambda r: r[1])
        return rows[:limit]

    def describe_near(self, x: float, y: float, z: float, *, dim: str = "overworld", radius: float = 64, limit: int = 12) -> str:
        rows = [(n, d) for n, d in self.nearest(x, y, z, dim=dim, limit=200) if d <= radius][:limit]
        if not rows:
            return "I have no memories of this area yet."
        parts = []
        for n, d in rows:
            tag = "" if n.confidence == "EXTRACTED" else f" ({n.confidence.lower()})"
            parts.append(f"{n.label} [{n.kind}] at ({n.x:.0f},{n.y:.0f},{n.z:.0f}) {d:.0f}m{tag}{(' — ' + n.notes) if n.notes else ''}")
        return "Known around here: " + "; ".join(parts) + "."

    def regions(self, resolution: float = 1.0) -> dict[int, list[str]]:
        """Deterministic community detection → regions (graphify: Louvain fallback with seed 42)."""
        if self.g.number_of_nodes() == 0:
            return {}
        comms = nx.community.louvain_communities(self.g, resolution=resolution, seed=42)
        ordered = sorted((sorted(c) for c in comms), key=lambda c: (-len(c), c[0]))
        out: dict[int, list[str]] = {}
        for i, members in enumerate(ordered):
            out[i] = members
            for m in members:
                self.g.nodes[m]["community"] = i
        return out

    def name_region(self, community: int, name: str) -> None:
        self._region_labels[community] = name
        for _nid, a in self.g.nodes(data=True):
            if a.get("community") == community:
                a["community_name"] = name

    def region_summary(self) -> list[dict[str, Any]]:
        regions = self.regions()
        out = []
        for cid, members in regions.items():
            kinds: dict[str, int] = {}
            xs = ys = zs = 0.0
            for m in members:
                a = self.g.nodes[m]
                kinds[a["kind"]] = kinds.get(a["kind"], 0) + 1
                xs += a["x"]
                ys += a["y"]
                zs += a["z"]
            n = len(members)
            out.append({"id": cid, "name": self._region_labels.get(cid), "size": n, "center": (round(xs / n), round(ys / n), round(zs / n)), "kinds": kinds})
        return out

    def query(self, terms: list[str], *, depth: int = 2, char_budget: int = 1500) -> str:
        """Seeded BFS over labels/kinds matching the terms, rendered as NODE/EDGE lines within a budget."""
        terms_l = [t.lower() for t in terms if t]
        seeds = [nid for nid, a in self.g.nodes(data=True) if any(t in a.get("label", "").lower() or t == a.get("kind") for t in terms_l)]
        if not seeds:
            return "no match"
        seen: list[str] = []
        frontier = seeds[:3]
        for _ in range(depth + 1):
            nxt: list[str] = []
            for nid in frontier:
                if nid in seen:
                    continue
                seen.append(nid)
                if self.g.degree(nid) > 50:  # hub: don't expand
                    continue
                nxt.extend(sorted(self.g.neighbors(nid), key=lambda n: self.g.edges[nid, n].get("weight", 1.0)))
            frontier = nxt
        lines: list[str] = []
        total = 0
        for nid in seen:
            a = self.g.nodes[nid]
            line = f"NODE {a['label']} [kind={a['kind']} at={a['x']:.0f},{a['y']:.0f},{a['z']:.0f} seen={a.get('count', 1)}x]"
            if total + len(line) > char_budget:
                lines.append("[!] TRUNCATED")
                break
            lines.append(line)
            total += len(line)
        for a_id, b_id, e in self.g.edges(seen, data=True):
            if a_id in seen and b_id in seen and e.get("relation") != "near":
                line = f"EDGE {self.g.nodes[a_id]['label']} --{e['relation']} [{e.get('confidence', 'EXTRACTED')}]--> {self.g.nodes[b_id]['label']}"
                if total + len(line) > char_budget:
                    break
                lines.append(line)
                total += len(line)
        return "\n".join(lines)

    def stats(self) -> dict[str, Any]:
        kinds: dict[str, int] = {}
        for _, a in self.g.nodes(data=True):
            kinds[a["kind"]] = kinds.get(a["kind"], 0) + 1
        return {"nodes": self.g.number_of_nodes(), "edges": self.g.number_of_edges(), "kinds": kinds}
