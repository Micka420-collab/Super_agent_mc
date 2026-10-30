import time

from emeth.llm.embeddings import Embedder
from emeth.llm.mock import MockProvider
from emeth.llm.router import LLMRouter
from emeth.memory.episodic import Timeline
from emeth.memory.procedural import SkillLibrary, parse_skill_file, safe_skill_name
from emeth.memory.semantic import Wiki, WikiPage
from emeth.memory.social import SocialMemory
from emeth.memory.spatial import WorldGraph
from emeth.memory.store import MemoryStore, retention
from tests.fakes import sample_observation


def make_embedder() -> Embedder:
    return Embedder(LLMRouter([MockProvider("m")]))


def test_store_episodes_and_fts(tmp_path):
    store = MemoryStore(tmp_path / "m.sqlite")
    store.add_episode("chat_in", "Steve: can you bring me some oak logs?", day=1, actors=["Steve"])
    store.add_episode("result", "mine succeeded: 3 oak_log", day=1)
    store.add_episode("death", "I died in lava", day=2, importance=0.9)
    assert store.count_episodes() == 3
    hits = store.search_episodes("oak logs")
    assert len(hits) == 2
    assert [e.kind for e in store.episodes_for_day(2)] == ["death"]
    assert len(store.unconsolidated_episodes()) == 3
    store.mark_consolidated([e.id for e in store.recent_episodes(limit=2)])
    assert len(store.unconsolidated_episodes()) == 1
    store.set("k", {"a": 1})
    assert store.get("k") == {"a": 1}
    assert store.incr("counter", 2) == 2


def test_pages_rrf_search_and_sweep(tmp_path):
    store = MemoryStore(tmp_path / "m.sqlite")
    emb = make_embedder()
    import asyncio

    e1 = asyncio.run(emb.embed_one("lava is dangerous, never dig straight down"))
    e2 = asyncio.run(emb.embed_one("Steve lives in a birch forest house at 120 64 -40"))
    store.upsert_page("lessons/lava.md", "lesson", "Never dig straight down", "Lava is dangerous. Never dig straight down near lava lakes.", embedding=e1, salience=0.8)
    store.upsert_page("places/steve.md", "place", "Steve's house", "Steve lives in a birch forest house at (120, 64, -40).", embedding=e2, entities=["Steve"], pinned=True)
    q = asyncio.run(emb.embed_one("where does steve live"))
    res = store.search_pages("steve house", q)
    assert res[0].path == "places/steve.md"
    res2 = store.search_pages("digging down lava", e1)
    assert res2[0].path == "lessons/lava.md"
    # retention: a fresh salient page scores high, an old never-accessed one decays
    assert retention(0.8, 0, 0, 0) > retention(0.8, 200, 0, 200)
    old = time.time() - 400 * 86400
    store.conn.execute("UPDATE pages SET created_at=?, updated_at=?, salience=0.1 WHERE path='lessons/lava.md'", (old, old))
    store.conn.commit()
    sweep = store.sweep_pages()
    assert sweep["deleted"] == 1 and store.get_page("places/steve.md") is not None  # pinned survives


def test_timeline_collapses_duplicates_and_renders(tmp_path):
    store = MemoryStore(tmp_path / "m.sqlite")
    tl = Timeline(store)
    tl.set_context(1, (0, 64, 0), "overworld")
    tl.add("chat_in", "Steve: hello")
    for _ in range(3):
        tl.add("damage", "hurt by zombie (health 15)")
    tl.add("said", "hi Steve")
    assert len(tl.entries) == 3
    assert tl.entries[1].count == 3
    text = tl.render()
    assert "(x3" in text and "Steve: hello" in text
    assert store.count_episodes() == 3
    assert tl.since_rewrite() == 3


async def test_wiki_write_search_brief_reindex(tmp_path):
    store = MemoryStore(tmp_path / "m.sqlite")
    wiki = Wiki(tmp_path / "wiki", store, make_embedder())
    await wiki.write(WikiPage(path="rules/no-grief.md", kind="rule", title="Never grief", body="Never break what players built.", pinned=True, salience=1.0))
    await wiki.note("lesson", "Creepers", "Creepers explode when close: back off 5 blocks.", tags=["combat"], salience=0.7)
    await wiki.note("lesson", "Creepers", "Shields block part of the blast.")
    page = wiki.read("lessons/creepers.md")
    assert page is not None and "Shields" in page.body and "explode" in page.body
    found = await wiki.search("creeper explosion", limit=3)
    assert found[0].title == "Creepers"
    brief = wiki.brief(max_chars=800, query_pages=found)
    assert brief.startswith("### Never grief") and "Creepers" in brief
    # rebuild the index from markdown files
    store2 = MemoryStore(tmp_path / "m2.sqlite")
    wiki2 = Wiki(tmp_path / "wiki", store2, make_embedder())
    n = await wiki2.reindex()
    assert n == 2 and wiki2.read("rules/no-grief.md").pinned  # type: ignore[union-attr]


def test_world_graph_observe_query_regions_persist(tmp_path):
    g = WorldGraph(tmp_path / "graph.json")
    obs = sample_observation()
    new = g.observe(obs)
    assert any(n.startswith("structure:chest") for n in new)
    assert any(n.startswith("player:Steve") for n in new)
    g.mark_place("home", 0, 64, 0, notes="my first shelter")
    g.add_node("resource", "iron_ore", 300, 40, 300)
    near = g.nearest(0, 64, 0, kind="structure")
    assert near and near[0][0].label in ("chest", "crafting_table")
    text = g.describe_near(0, 64, 0)
    assert "home" in text and "chest" in text
    q = g.query(["chest"])
    assert "NODE chest" in q
    regions = g.regions()
    assert len(regions) >= 2  # the far iron ore forms its own region
    g.name_region(0, "Spawn meadow")
    g.save()
    g2 = WorldGraph(tmp_path / "graph.json")
    assert g2.stats()["nodes"] == g.stats()["nodes"]
    assert g2.region_summary()[0]["name"] == "Spawn meadow"


async def test_skill_library_roundtrip(tmp_path):
    store = MemoryStore(tmp_path / "m.sqlite")
    lib = SkillLibrary(tmp_path / "skills", store, make_embedder())
    code = "async function main(api, args) { return await api.mine({ name: 'oak_log', count: args.count || 3 }); }"
    s = await lib.add("Gather Oak Logs!", code, "Mine oak logs nearby", tags=["gather"])
    assert s.name == "gather_oak_logs" and (tmp_path / "skills" / "gather_oak_logs.js").exists()
    loaded = lib.get("gather_oak_logs")
    assert loaded is not None and "async function main" in loaded.code and loaded.description == "Mine oak logs nearby"
    lib.record_outcome("gather_oak_logs", True, 1200)
    lib.record_outcome("gather_oak_logs", False, 800)
    rec = store.get_skill("gather_oak_logs")
    assert rec is not None and rec.uses == 2 and rec.success_rate == 0.5
    hits = await lib.retrieve("collect wood logs from trees")
    assert hits and hits[0].name == "gather_oak_logs"
    s2 = await lib.add("gather_oak_logs", code + "\n// v2", "Mine oak logs nearby (v2)")
    assert s2.version == 2 and (tmp_path / "skills" / "gather_oak_logs.v1.js").exists()
    parsed = parse_skill_file((tmp_path / "skills" / "gather_oak_logs.js").read_text(), fallback_name="x")
    assert parsed.name == "gather_oak_logs" and parsed.version == 2
    lib.retire("gather_oak_logs")
    assert store.get_skill("gather_oak_logs") is None
    assert safe_skill_name("123 bad name") == "s_123_bad_name"


def test_social_memory_trust_dynamics(tmp_path):
    store = MemoryStore(tmp_path / "m.sqlite")
    social = SocialMemory(store, owner="Micka")
    p = social.on_chat("Micka", "salut, tu peux me ramener du bois ?")
    assert p.trust >= 0.8 and social.is_owner("Micka")
    q = social.on_chat("Griefer", "you are useless, I hate you")
    assert q.trust < 0.5
    social.on_attacked_by("Griefer")
    assert store.get_person("Griefer").relationship in ("stranger", "rival")  # type: ignore[union-attr]
    social.on_gift("Steve", "bread", 3)
    social.on_chat("Steve", "I will bring you more tomorrow, promise")
    desc = social.describe("Steve")
    assert "gave me 3 bread" in desc and "promise" in desc
    block = social.render_block(present=["Steve"])
    assert block.startswith("Steve")
