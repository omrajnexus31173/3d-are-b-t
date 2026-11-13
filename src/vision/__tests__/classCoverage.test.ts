/**
 * "Unclassified" is a taxonomy-mapping result, not a decoding fault.
 *
 * The offline audit proved labels arrive in 0..79 and index the official COCO
 * order correctly, so a row shown as "Unclassified" was decoded correctly and
 * simply has no BHARAT-AV traffic class to map onto.
 *
 * These tests pin that down so the symptom cannot be mistaken for a decode bug
 * or quietly "fixed" by renaming the label.
 */
import { describe, it, expect } from 'vitest';
import { COCO_LABELS, VISION_CLASS_LABELS, mapLabelToVisionClass } from '../detector';

describe('COCO/D-FINE label table', () => {
  it('is the official 80-class order, so indices decode correctly', () => {
    expect(COCO_LABELS).toHaveLength(80);
    expect(COCO_LABELS[0]).toBe('person');
    expect(COCO_LABELS[2]).toBe('car');
    expect(COCO_LABELS[5]).toBe('bus');
    expect(COCO_LABELS[9]).toBe('traffic light');
    expect(COCO_LABELS[79]).toBe('toothbrush');
  });

  it('maps every traffic-relevant class the product cares about', () => {
    // These are the classes the overlay must never show as Unclassified.
    for (const label of ['person', 'car', 'bus', 'truck', 'motorcycle', 'bicycle', 'traffic light']) {
      expect(mapLabelToVisionClass(label), `${label} must map`).not.toBe('unknown');
    }
  });

  it('leaves exactly the non-traffic classes unmapped', () => {
    const unmapped = COCO_LABELS.filter((l) => mapLabelToVisionClass(l) === 'unknown');
    // 63 of 80: the classes a traffic taxonomy has no slot for.
    expect(unmapped).toHaveLength(63);
    // Spot-check both sides of the boundary.
    expect(unmapped).toContain('chair');
    expect(unmapped).toContain('laptop');
    expect(unmapped).toContain('train');
    expect(unmapped).not.toContain('person');
    expect(unmapped).not.toContain('car');
  });

  it('renders unmapped classes as "Unclassified" rather than renaming them', () => {
    expect(mapLabelToVisionClass('chair')).toBe('unknown');
    expect(VISION_CLASS_LABELS.unknown).toBe('Unclassified');
  });

  it('fetches the real COCO name for every valid index, never "class N"', () => {
    // The overlay labels a detection from VISION_CLASS_LABELS[classId], and the
    // modelLabel carries the true COCO name for debugging. A wrong index would
    // show up as an out-of-range label, which the decoder rejects separately.
    for (let i = 0; i < 80; i++) {
      expect(COCO_LABELS[i]).toBeTruthy();
      expect(COCO_LABELS[i]).not.toMatch(/^class \d+$/);
    }
  });
});
