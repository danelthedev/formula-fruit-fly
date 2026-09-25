# Racing Sim — Initial Plan

## Goal
Browser web app: draw circuit → configure teams → train NN drivers (client-side, GPU) → qualifying → race. No server compute; static hosting enough.

## Stack (proposed)
- Vite + TypeScript + Canvas 2D (track editor + race renderer).
- TensorFlow.js (WebGL backend = GPU accel, CPU fallback) for NN training/inference. Weights stored as JSON.
- State: Zustand or plain stores. Persistence: localStorage (teams, config) + IndexedDB (tracks as point arrays, NN weights, larger blobs). Export/import JSON files for sharing.
- Physics: custom 2D bicycle-ish arcade model (cheap, deterministic, 60Hz fixed timestep). No physics lib needed.

## Features (from requirements)
1. **Track editor**: click-drag draw centerline on canvas → resampled + smoothed → width assigned → closed loop, self-intersection rejected, undo stack (stroke-level + point-level). User places start/finish line (click on track to set position + auto normal direction).
2. **Checkpoints**: auto-placed along centerline at even arc-length intervals (e.g. every ~5% or N gates). Gates = perpendicular segments across track width. Used for lap validation, progress reward, position ranking.
3. **Teams**: name, primary/secondary color, car specs (top speed, acceleration, brake efficiency, turning ability). Specs feed physics params per team. CRUD + validation.
4. **Training**: "Start training" → per-team population of NNs, one env per team using that team's physics. Action: throttle [0,1], brake [0,1], steer [-1,1]. Crash = all 4 wheels / center off track → episode fail. Stop button → keep best weights per team as driver profile.
5. **Drivers per team**: N configurable (same for all). Each driver = copy of team best net (+ optional noise/variance for personality).
6. **Qualifying**: 1 flying lap each, solo on track, sorted by time (DNF = back, ordered by progress). Grid slots generated behind start line, staggered F1-style (2 columns, offset rows).
7. **Race**: configurable laps, all cars together, ghost mode (no car-car collision v1). Off-track = crash → DNF removed. Live positions from lap+checkpoint+arc progress. Results table.
8. **Save/load**: teams, tracks (centerline points + width + start pose + checkpoints derived), NN weights per team, app config. Browser storage auto-persist + named slots + JSON file export/import.

## NN Design (proposal)
- **Inputs (~14–18)**: speed (normalized), lateral offset from centerline, heading error to track tangent, steer/throttle history (optional), N forward raycasts to track edge (e.g. 7–9 rays over ±90°, normalized 0–1), angle/distance to next K checkpoints (1–2 lookahead). All normalized [-1,1] or [0,1].
- **Outputs (3)**: throttle [0,1] (sigmoid), brake [0,1] (sigmoid), steer [-1,1] (tanh).
- **Arch**: MLP 16→64→64→3 (~5k params). Fast in TF.js, enough for line-following + racing line.
- **Algo v1**: Genetic Algorithm / neuroevolution (population 50–200, tournament select, gaussian mutate, elitism). Why: trivial to implement on TF.js, no gradients, robust to sparse crash reward, parallel sims easy. **v2 option**: PPO/ES if GA plateaus.
- **Reward**: progress along centerline (checkpoints passed × gate index + fractional) + small speed bonus − crash penalty − off-line penalty. Fitness = progress − time penalty.
- **Sim**: fixed dt (1/60), per-team physics scaling from specs. Headless fast-forward during training (multiple sim steps per frame, Web Worker optional).

## Training Hardware
- 100% client-side. TF.js WebGL backend → GPU. tfjs-node not needed (browser only). Fallback WASM/CPU. Batch inference per population for throughput. Workers keep UI responsive.

## Risks / Decisions
- Self-intersection detection must run live during draw (R-tree or segment check on resampled polyline, windowed).
- Track representation: centerline polyline + uniform width v1 (variable width later). Rasterize to off-road mask (offscreen canvas) for fast crash checks.
- GA needs fast sim: keep physics + raycasts cheap (precomputed centerline SDF/polygon, raymarch on mask).
- Scope cut v1: no car collisions, uniform track width, fixed checkpoint count, GA only.

## Deliverable Map
Staged goals: track maker → team config → training → quali/race. Each with save/load. See `stories.md`.
