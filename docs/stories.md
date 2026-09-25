# Racing Sim — Implementation Stories (staged goals)

Each goal = independent, demoable, includes save/load. Order matters; each builds on prior. DoD = acceptance criteria met + persisted.

## Goal 1 — Track Maker
**Scope**: canvas draw (pointer drag), resample+smooth, closed-loop enforce, self-intersection reject (live + on close), undo (stroke + point-level, redo optional), track width slider, start/finish placement (click on centerline, auto direction, draggable), auto checkpoints.
**Track model**: `{ id, name, centerline: [x,y] (resampled meters/px), width, startPose {s, dir}, checkpoints: [{s, p1, p2}] }`. Checkpoints derived at even arc-length (N=20 default). Crash mask = offscreen canvas raster.
**Save/load**: named tracks in IndexedDB (+ localStorage index); export/import JSON; autosave draft.
**DoD**: draw → valid closed non-overlapping loop → undo works → width+start set → checkpoints render → reload persists → invalid (open/self-crossing) blocked with message.
**Test**: one `assert` self-check: resample + intersection fn on fixture shapes.

## Goal 2 — Team Configurer
**Scope**: team CRUD: name (unique), primary/secondary color (car render preview), specs: topSpeed, acceleration, brakeEfficiency, turningAbility (sliders 1–10 mapped to physics params). Validation + preview livery on mini car sprite.
**Physics map** (central `SPEC_MAP`): topSpeed→vMax, accel→engine force, brake→brake force, turning→max steer angle / lateral grip. Same map used by training + race.
**Save/load**: teams array in localStorage; export/import JSON; persists across sessions.
**DoD**: create/edit/delete teams (≥1 to proceed) → specs clamp validated → preview shows colors → reload keeps teams.
**Test**: `SPEC_MAP` monotonicity assert (higher spec → ≥ param).

## Goal 3 — Training
**Scope**: per-team GA training on user hardware (TF.js WebGL). Config: population, mutation σ, episodes/epoch, sim speed multiplier. Controls: Start / Stop / resume; live charts (best/avg fitness, progress); best-weights kept per team as driver profile. Crash = off-track → episode end.
**NN**: inputs ~14–18 (speed, lateral offset, heading error, 7–9 edge rays, 1–2 checkpoint lookahead), MLP 64×64, outputs throttle/brake/steer. GA: tournament + elitism + gaussian mutate. Headless fast sim, batched inference; Worker optional v2.
**Save/load**: best weights per team in IndexedDB (TF.js JSON), training config in localStorage; export/import weights JSON; "load weights → skip retrain" path.
**DoD**: train 1 team few epochs headless → fitness improves → Stop keeps usable weights → car completes lap with loaded weights → reload keeps weights.
**Test**: one assert: mutated net inference shapes in [0,1]/[-1,1]; sim step deterministic given seed.

## Goal 4 — Qualifying + Race
**Scope**:
- Drivers-per-team N (global, same all teams). Roster = N copies of team best net (+ tiny noise option).
- Qualifying: solo 1 lap each, timeout (e.g. 3× expected), sort by time (DNF by progress). Grid gen behind start line, F1 stagger (2 cols, row gap, alternate sides, pole front-left/right).
- Race: configurable laps, ghost mode (no collisions), mass start from grid, off-track = DNF removed, live positions (lap → checkpoint idx → arc s), lap times, results table + replay (optional).
**Save/load**: race config (laps, N drivers, grid order, results) in localStorage; full event export JSON (track id + teams + weights refs + results).
**DoD**: quali orders grid correctly → race runs N cars L laps → DNF handled → results correct → reload keeps config+results.
**Test**: one assert: position sort fn (lap, gate, s) on fixture.

## Cross-cutting
- `storage.ts`: single API (save/load/list/export/import) over localStorage+IndexedDB; versioned keys (`rs.v1.*`); used by all goals. Build in Goal 1, extend per goal.
- Fixed-timestep sim core (`sim.ts`) shared by training + quali + race; physics in one place.
- ponytail: no backend, no auth, no multiplayer, no car-car collision (ghost v1); add when asked.
