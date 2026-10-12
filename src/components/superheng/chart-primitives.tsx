import { View } from 'react-native';

export type SegmentProps = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  thickness: number;
  /** Optional dash pattern simulated with opacity gaps (kept simple here). */
  opacity?: number;
};

/**
 * Draws a straight line between two points using a rotated bar.
 *
 * The bar is positioned so that its own center sits on the segment midpoint,
 * which means the default rotation origin is already correct — no
 * `transformOrigin` support required.
 */
export function Segment({ x1, y1, x2, y2, color, thickness, opacity = 1 }: SegmentProps) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;

  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: (x1 + x2) / 2 - length / 2,
        top: (y1 + y2) / 2 - thickness / 2,
        width: length,
        height: thickness,
        borderRadius: thickness / 2,
        backgroundColor: color,
        opacity,
        transform: [{ rotate: `${angle}deg` }],
      }}
    />
  );
}

export type Point = { x: number; y: number };
