"""Pydantic mirror of the body's wire protocol (body/src/protocol.ts). Keep both in sync; the
fixtures in /protocol/fixtures are validated by both test suites."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

PROTOCOL_VERSION = "0.1.0"


class Loose(BaseModel):
    """Base model tolerant to new fields added by the body."""

    model_config = ConfigDict(extra="allow")


class Vec3(Loose):
    x: float
    y: float
    z: float

    def distance_to(self, other: Vec3) -> float:
        return ((self.x - other.x) ** 2 + (self.y - other.y) ** 2 + (self.z - other.z) ** 2) ** 0.5

    def floored(self) -> tuple[int, int, int]:
        import math

        return (math.floor(self.x), math.floor(self.y), math.floor(self.z))

    def short(self) -> str:
        return f"({self.x:.0f}, {self.y:.0f}, {self.z:.0f})"


class ItemStack(Loose):
    name: str
    count: int
    displayName: str | None = None
    slot: int | None = None
    durability: float | None = None
    maxDurability: float | None = None
    enchants: list[str] | None = None


EntityKind = Literal["player", "hostile", "passive", "neutral", "item", "projectile", "vehicle", "other"]


class EntityView(Loose):
    id: int
    name: str
    kind: EntityKind
    position: Vec3
    distance: float
    bearing: str
    relative: str
    visible: bool
    username: str | None = None
    health: float | None = None
    heldItem: str | None = None
    itemName: str | None = None
    itemCount: int | None = None

    def label(self) -> str:
        return self.username or self.name


class BlockView(Loose):
    name: str
    position: Vec3
    distance: float
    light: float | None = None


class ChatLine(Loose):
    ts: float
    from_: str = Field(alias="from")
    text: str
    type: Literal["chat", "whisper", "system"]

    model_config = ConfigDict(extra="allow", populate_by_name=True)


class RecentEvent(Loose):
    ts: float
    event: str
    summary: str


class SelfState(Loose):
    username: str
    position: Vec3
    yaw: float
    pitch: float
    health: float
    food: float
    saturation: float
    oxygen: float
    xpLevel: float
    xpProgress: float
    gameMode: str
    dimension: str
    onGround: bool
    isSleeping: bool
    isInWater: bool
    isInLava: bool
    isOnFire: bool
    velocity: Vec3
    heldItem: ItemStack | None
    offhandItem: ItemStack | None
    armor: dict[str, str | None]
    effects: list[dict[str, Any]]
    biome: str


class WorldState(Loose):
    timeOfDay: float
    day: int
    phase: Literal["dawn", "day", "dusk", "night"]
    isRaining: bool
    isThundering: bool
    lightLevel: float
    skyLight: float
    moonPhase: int | None = None


class InventoryState(Loose):
    items: list[ItemStack]
    freeSlots: int
    totalSlots: int
    hotbar: list[ItemStack | None]
    selectedHotbarSlot: int

    def count(self, name: str) -> int:
        return sum(i.count for i in self.items if i.name == name)

    def summary(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for i in self.items:
            out[i.name] = out.get(i.name, 0) + i.count
        return out


class ThreatState(Loose):
    """The body's own reading of the odds (motor/threat.ts): danger 0..1 and what a player would do."""

    danger: float
    recommendation: Literal["calm", "watch", "fight", "retreat", "flee"]
    reasons: list[str] = Field(default_factory=list)
    count: int = 0
    strength: float = 0.5
    nearest: dict[str, Any] | None = None


class EntitiesState(Loose):
    players: list[EntityView]
    hostiles: list[EntityView]
    passives: list[EntityView]
    items: list[EntityView]
    other: list[EntityView]
    threat: ThreatState | None = None


class Enclosure(Loose):
    enclosed: bool
    cells: int
    roofed: bool
    summary: str


class BlocksState(Loose):
    standingOn: str
    atFeet: str
    atHead: str
    facing: BlockView | None
    notable: list[BlockView]
    nearbyCounts: dict[str, int]
    enclosure: Enclosure | None = None


class VisionState(Loose):
    visible: list[BlockView]
    horizon: dict[str, str]
    fovDeg: float
    rays: int


class CurrentAction(Loose):
    id: str
    name: str
    startedAt: float


class Observation(Loose):
    ts: float
    tick: int
    detail: Literal["compact", "full"]
    self_: SelfState = Field(alias="self")
    world: WorldState
    inventory: InventoryState
    entities: EntitiesState
    blocks: BlocksState
    vision: VisionState | None = None
    chat: list[ChatLine]
    events: list[RecentEvent]
    action: CurrentAction | None

    model_config = ConfigDict(extra="allow", populate_by_name=True)


class ActionResult(Loose):
    id: str
    action: str
    ok: bool
    result: Any = None
    error: str | None = None
    errorCode: str | None = None
    startedAt: float
    finishedAt: float
    interruptedBy: str | None = None

    @property
    def duration_ms(self) -> float:
        return self.finishedAt - self.startedAt


class SkillTraceEntry(Loose):
    t: float
    call: str
    ok: bool
    ms: float
    error: str | None = None


class SkillRunResult(Loose):
    id: str
    name: str
    ok: bool
    result: Any = None
    error: str | None = None
    errorCode: str | None = None
    logs: list[str]
    trace: list[SkillTraceEntry]
    startedAt: float
    finishedAt: float
    interruptedBy: str | None = None


class SkillCheckResult(Loose):
    ok: bool
    problems: list[str]
    apiCalls: list[str]


class ActionManifestEntry(Loose):
    name: str
    description: str
    params: dict[str, Any]
    category: str
    longRunning: bool


class HelloResult(Loose):
    protocol: str
    body: dict[str, str]
    minecraft: dict[str, Any]
    capabilities: dict[str, Any]
    actions: list[ActionManifestEntry]
    skillApiDoc: str


class RenderResult(Loose):
    width: int
    height: int
    pngBase64: str
    legend: dict[str, str]
    description: str
    source: str


class ReflexConfig(Loose):
    enabled: bool = True
    autoEat: bool = True
    eatAtFood: float = 14
    autoDefend: bool = True
    defendRange: float = 6
    fleeAtHealth: float = 7
    fleeAtDanger: float = 0.8
    fleeDistance: float = 16
    avoidCreepers: bool = True
    creeperRange: float = 5
    surfaceWhenDrowning: bool = True
    drownAtOxygen: float = 8
    escapeLavaAndFire: bool = True
    autoArmor: bool = True
    allies: list[str] = Field(default_factory=list)


class EventEnvelope(Loose):
    kind: Literal["event"]
    event: str
    ts: float
    payload: Any


class ResponseEnvelope(Loose):
    kind: Literal["response"]
    id: str
    ok: bool
    result: Any = None
    error: dict[str, Any] | None = None


class RequestEnvelope(BaseModel):
    kind: Literal["request"] = "request"
    id: str
    method: str
    params: Any = None


class BodyError(Exception):
    """Raised when the body answers a request with an error."""

    def __init__(self, code: str, message: str, data: Any = None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.data = data
