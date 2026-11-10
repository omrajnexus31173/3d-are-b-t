# BHARAT-AV — Roadmap

Planned features are recorded here so they are not lost between phases. Nothing
in this file is implemented unless its phase is marked complete.

---

## Phase 4 (planned) — Infinite Procedural Road Generation

**Status:** planned, not started. Recorded during Phase 2C at the project
owner's request.

### Objective

Make the existing 3D driving simulation support an effectively endless,
continuously generated road environment.

### Required functionality

1. The road must never reach a visible endpoint during normal simulation.
2. Generate road segments progressively ahead of the vehicle.
3. Recycle or remove segments behind the vehicle to bound memory and draw calls.
4. Smooth transitions between segments — no visible gaps, jumps or flicker.
5. Procedurally generate configurable environments: highways, urban roads,
   rural roads, village roads, roads with dividers, intersections.
6. Generate surrounding scenery: trees, buildings, streetlights, road signs,
   roadside objects.
7. Spawn traffic (vehicles, motorcycles, bicycles, pedestrians, cattle) with
   configurable density and spawn rules.
8. Configurable road hazards, including potholes. **Generated hazards are
   simulated scenery and must never be presented as real-world AI detections.**
9. Preserve existing simulation controls, physics, camera, telemetry and the AI
   perception pipeline.
10. Procedural objects need stable identities so the existing simulation
    perception engine can track them.
11. Generation must be deterministic from a configurable random seed, so tests
    are reproducible.
12. Provide controls for road type, traffic density, environment density and
    generation settings.
13. Optimise for the existing architecture: no unbounded memory or object growth.

### Architecture constraints

- Simulation, real-camera and hybrid modes stay independent.
- Infinite generation applies to the **simulated** environment only — never to
  the physical phone camera feed.
- Do not replace the existing simulation with a new game engine.
- Reuse the existing road, vehicle, agent and rendering components.
- No expensive dependencies without explicit justification.

### Acceptance criteria

- The vehicle can travel continuously without reaching a road endpoint.
- At least 1,000 simulated segments traversed with no visible discontinuity.
- Memory and active object counts stay bounded through recycling.
- No noticeable frame-rate degradation over an extended run.
- Existing simulation and camera functionality continue to work.

### Suggested approach (for the later phase, not decided)

Segment-ring architecture: a fixed pool of N road chunks keyed by index,
`seed + segmentIndex` driving a deterministic PRNG, +1 chunk generated ahead and
−1 released behind each frame. Reuse existing mesh/material instances and the
existing vehicle/agent factories so identities remain stable.

---

## Phase 2C — AI detection on the received phone stream

**Status:** complete (automated browser verification only; no physical phone).

The detection engine scores the WebRTC-received phone video, emits `CAM-`
prefixed tracks, and those appear in the hybrid telemetry alongside — and
separate from — `SIM` identifiers.
