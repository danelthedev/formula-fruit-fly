# Single Race — Implementation Plan (Story 3+4, user spec)

Goal: from the Races tab run a full single-race event — setup → practice (GA training)
→ qualifying → race — on the user's tracks with the user's teams. Championship stays
a placeholder button. Client-only (Vite + TS + Canvas + TF.js WebGL), no backend.

## 1. User flow (screens in the Races view)

1. **Races landing**: two buttons — `Single race` / `Championship`.
   Championship → the existing under-construction placeholder. No other change.
2. **Single-race setup** (replaces landing content): three selections + confirm.
   - Track: dropdown of saved tracks (requires ≥1 saved track; else hint to build one).
   - Teams: checkboxes of configured teams (requires ≥1 checked).
   - Drivers per team: number input 1–4, global (same for all teams).
   - Laps: number input 1–10, default 3.
   - `Begin practice` validates (track + ≥1 team) and locks the selections in.
3. **Practice session** (the training process):
   - `Start training` runs GA per team on the selected track with team physics;
     `Stop` ends it (weights kept). `Import weights` per team from a saved file
     skips retraining for that team.
   - Live panel: epoch counter, best/avg fitness sparkline per selected team.
   - `Preview every X epochs` (number input, default 0 = off): at each Xth epoch
     boundary training pauses and the current-epoch best candidate of EVERY team
     drives one lap simultaneously (ghost cars, no collisions), then training resumes.
   - `Current Epoch Preview` button: pauses immediately, same simultaneous preview
     of best-so-far this epoch, resumes on `Resume training`.
   - `Export weights` per team (JSON file). Any team with weights (trained or
     imported) counts as ready.
   - `Start Qualifying` enabled once every participating team is ready.
4. **Qualifying session**: drivers go out SEQUENTIALLY, one flying lap each, with a
   timeout (3× expected lap from track length / team vMax). Live quali board on the
   LEFT side of the track: Pos / Driver (Team) / Time-or-Gap / status; DNFs sorted
   by progress behind finishers. When all drivers are done, `Start race` enables.
5. **Race**: mass start from an F1-staggered grid behind the start line, ghost mode
   (no car-car collisions), off-track = DNF removed. Live positions by
   (lap → checkpoint idx → arc s), per-driver lap times, results table at the end.

## 2. Session state machine

`setup → practice → quali → race`, forward-only buttons gating each step:
Begin practice → (Stop) → Start Qualifying → (all drivers done) → Start Race.
Back-navigation: `Back to setup` on practice/quali discards session progress but keeps
selections and weights. Switching top nav away and back preserves session state
in memory (persist session snapshot to storage on transitions; exact keys §5).

## 3. Sim core (new `src/sim.ts`, shared by practice/quali/race)

Fixed timestep dt = 1/60, seeded RNG (deterministic replays/tests).
- Car state: pos, heading, speed; arcade bicycle-ish update from
  (throttle, brake, steer) + team `PhysicsParams` (SPEC_MAP, already central).
- Track queries on the selected centerline: nearest arc s + tangent (reuse
  `projectFraction`-style projection), lateral offset, off-track test
  (dist-to-centerline vs interpolated half-width), gate-crossing progress.
- Episode: spawn at start line (heading = tangent), step until crash (off-track),
  timeout, or lap(s) complete. Returns progress (gates + fractional s), time, done.
- Headless fast-forward: N sim steps per animation frame (speed multiplier),
  no rendering inside the hot loop.

## 4. NN + GA (TF.js)

- Net: MLP 16→64→64→3 (inputs: speed, lateral offset, heading error, 7–9 edge
  rays, 1–2 checkpoint lookaheads; outputs throttle/brake sigmoid, steer tanh).
  Matches `docs/initial_plan.md`.
- GA per team: population 64, elite 4, tournament select, gaussian mutate σ=0.05,
  3 episodes per candidate per epoch. Batched inference across the population.
- Fitness: gate progress + fractional s, small speed bonus, crash/time penalties.
- Config inputs (practice panel, with defaults): population, mutation σ,
  preview-every-X. Episodes fixed at 3 (not exposed v1).
- Weights: per-team best (all-time) + per-epoch best (for previews).

## 5. Storage (extends `src/storage.ts` kv store, IndexedDB)

- `rs.v1.weights.<teamId>` — best weights per team (TF.js JSON: topology + arrays).
- `rs.v1.racecfg` — last single-race setup (track id, team ids, drivers, laps, X).
- `rs.v1.racesession` — session snapshot (stage, quali board, results) for reload.
- Weights files: `{ teamId, teamName, topology, weights }` JSON export/import.

## 6. UI layout notes

- Races view swaps panels by stage; track canvas reused for practice previews,
  quali laps, and the race (ghost cars in team colors).
- Quali board: flex row `[board | canvas | side panel]` during quali/race only;
  board hidden otherwise. Positions update live.
- Charts: one lightweight canvas sparkline (no chart lib).
- All long loops are frame-sliced (no UI freeze); Stop works mid-epoch.

## 7. Subtasks (each demoable, with save/load where state exists)

1. **Sim core** — `src/sim.ts`: step, spawn, off-track, gate progress, timeout;
   seeded determinism. DoD: scripted throttle/steer run completes a lap on a
   test oval; crash detected off-track. Test: deterministic replay assert
   (same seed → identical final s) + off-track boolean on fixture.
2. **TF.js scaffold + GA** — net build/inference/dispose, mutate/crossover,
   per-team population loop headless on a fixture track. DoD: 3 epochs run in
   browser, best fitness non-decreasing on average, no leaks (tf.memory stable).
   Test: mutated-net output ranges ([0,1]/[0,1]/[-1,1]) + shapes (DoD per stories.md).
3. **Weights storage** — IDB keys + export/import files + per-team ready flags.
   DoD: train → reload → weights present; file round-trip identical. Test: JSON
   round-trip assert (node-side shape check).
4. **Single-race setup UI** — track dropdown, team checkboxes, drivers/laps inputs,
   validation + Begin practice. DoD: invalid (no track/teams) blocked with message;
   valid locks selections. Test: validation fn asserts (pure logic extracted).
5. **Practice session UI + loop** — Start/Stop/Resume, epoch + sparkline panel,
   per-team import/export weights, training config inputs, Start Qualifying gating.
   DoD: stop keeps usable weights; car completes a lap on loaded weights
   (stories.md DoD). E2E: 2 teams × tiny population × 2 epochs headless.
6. **Previews (auto + manual, simultaneous)** — pause-at-boundary, all-teams-best
   ghost lap, resume; X=0 disables auto; manual pauses mid-epoch. DoD: during a
   preview N team-colored ghosts visible at once; training resumes after. E2E:
   screenshot + epoch counter continuity.
7. **Qualifying** — sequential laps, timeout/DNF, left board live, grid preview.
   DoD: board orders finishers by time, DNFs by progress; reload keeps board.
   Test: position-sort fn on fixture (stories.md DoD).
8. **Grid + race** — F1-stagger spawn, mass start, live positions, lap times,
   DNF removal, results table + session persist. DoD: 2 teams × 2 drivers × 2 laps
   completes with correct winner; reload keeps results. E2E: scripted short race.

## 8. Open decisions (defaults in place; revisit on feedback)

- Preview fleets show current-epoch bests (manual = best-so-far).
- Episodes/epoch fixed at 3; expose only population/σ/X.
- Back-to-setup keeps weights, drops session progress.
- Timeout 3× expected lap; expected = centerline length / (0.8 × fastest vMax).

## 9. Risks

- TF.js first-load weight (~500KB CDN/npm) — bundle impact; consider lazy import
  on first Races visit.
- Training throughput on weak iGPUs — population default 64 may need lowering;
  expose it (done in §4) and keep per-epoch work interruptible.
- Raycast cost in the hot loop — precompute edge polygons once per track;
  profile before optimizing.

## 10. Out of scope (v1)

Championship mode, car-car collisions (ghost only), pit stops, weather, race
restarts from mid-session, multiplayer, drivetrain tuning beyond the 4 specs.
