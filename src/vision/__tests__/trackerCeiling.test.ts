import { describe, expect, it } from 'vitest';
import { IouTracker } from '../tracker';

/** Deterministic LCG so "scattered spurious boxes" are reproducible. */
function lcg(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

function scatter(count: number, rnd: () => number) {
  return Array.from({ length: count }, () => ({
    box: {
      x: rnd() * 580,
      y: rnd() * 440,
      width: 20 + rnd() * 40,
      height: 20 + rnd() * 40,
    },
    classId: 'car' as const,
    modelLabel: 'car',
    confidence: 0.4,
  }));
}

describe('track accumulation ceiling', () => {
  it('never returns more live tracks than maxTracks, however many frames pass', () => {
    const tracker = new IouTracker({ maxTracks: 64 });
    const rnd = lcg(42);
    let peak = 0;
    for (let f = 0; f < 20; f++) {
      const live = tracker.update(scatter(40, rnd), 1000 + f * 125);
      peak = Math.max(peak, live.length);
    }
    // Before the ceiling this reached ~280 simultaneous boxes.
    expect(peak).toBeLessThanOrEqual(64);
  });

  it('does not starve a real object when spurious tracks are evicted', () => {
    const tracker = new IouTracker({ maxTracks: 8 });

    // One genuine, repeatedly-matched object.
    const genuine = {
      box: { x: 100, y: 100, width: 80, height: 80 },
      classId: 'car' as const,
      modelLabel: 'car',
      confidence: 0.9,
    };
    let tracks = tracker.update([genuine], 1000);
    const genuineId = tracks[0].trackId;
    tracks = tracker.update([genuine], 1125);
    expect(tracks.find((t) => t.trackId === genuineId)?.hits).toBe(2);

    // Now flood with low-confidence noise in a different part of the frame.
    const rnd = lcg(7);
    for (let f = 0; f < 5; f++) {
      const noise = Array.from({ length: 40 }, () => ({
        box: {
          x: 400 + rnd() * 150,
          y: 20 + rnd() * 100,
          width: 15,
          height: 15,
        },
        classId: 'car' as const,
        modelLabel: 'car',
        confidence: 0.36,
      }));
      tracker.update([genuine, ...noise], 1250 + f * 125);
    }

    const final = tracker.update([genuine], 2000);
    const survivor = final.find((t) => t.trackId === genuineId);
    // The high-confidence, repeatedly-confirmed track must still be alive.
    expect(survivor).toBeDefined();
    expect(final.length).toBeLessThanOrEqual(8);
  });

  it('keeps unbounded behaviour available by setting a high ceiling', () => {
    const tracker = new IouTracker({ maxTracks: 10_000 });
    const rnd = lcg(3);
    for (let f = 0; f < 10; f++) tracker.update(scatter(40, rnd), 1000 + f * 125);
    // Proves the ceiling is what bounds it, not some other accidental cap.
    expect(tracker.size).toBeGreaterThan(64);
  });
});
