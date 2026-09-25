/**
 * WireRenderer — purely visual renderer for a single wire.
 * All interaction (click/hover/drag) is handled by SimulatorCanvas.
 */

import React from 'react';
import type { Wire } from '../../types/wire';
import { generateOrthogonalPath } from '../../utils/wireUtils';
import { cssVar } from '../../lib/theme';

interface WireRendererProps {
  wire: Wire;
  isSelected: boolean;
  isHovered: boolean;
  /** Temporary waypoints used during drag preview */
  previewWaypoints?: { x: number; y: number }[];
  /** Override the full SVG path string (used during segment drag preview) */
  overridePath?: string;
  /**
   * Agent reveal: ms before this wire draws itself in (pin-to-pin).
   * Absent/undefined = a normal wire. Purely cosmetic — the wire already
   * exists in the store and in the simulation.
   */
  revealDelayMs?: number;
}

export const WireRenderer: React.FC<WireRendererProps> = ({
  wire,
  isSelected,
  isHovered,
  previewWaypoints,
  overridePath,
  revealDelayMs,
}) => {
  // Breadboard seating wires are pure connectivity — the part visually
  // sits in the holes, so there is nothing to draw.
  if (wire.bb) return null;

  const waypoints = previewWaypoints ?? wire.waypoints;
  const path = overridePath ?? generateOrthogonalPath(wire.start, waypoints, wire.end);

  if (!path) return null;

  const color = wire.color;
  // Wire COLOUR is the user's; the outline, the hover wash and the selection
  // dashes are canvas chrome and follow the theme. On a light canvas the old
  // near-black outline read as a heavy shadow around every run, and the white
  // hover/selection strokes were invisible outright.
  const outline = cssVar('--color-wire-outline');
  const marker = cssVar('--color-wire-marker');
  const strokeW = isSelected ? 3 : 2;
  const outlineW = isSelected ? 6 : 5;
  const opacity = isSelected || isHovered ? 1 : 0.85;

  // Draw-in: pathLength=1 + dasharray 1 + dashoffset 1 -> 0 (AgentReveal.css).
  // The reveal path skips hover/selection decorations — no one inspects a
  // wire mid-draw.
  const revealing = revealDelayMs != null && revealDelayMs >= 0;
  const drawStyle = revealing ? { animationDelay: `${revealDelayMs}ms` } : undefined;
  const dotDelay = revealing ? revealDelayMs + 380 : undefined;

  return (
    <g style={{ pointerEvents: 'none' }} strokeLinecap="round" strokeLinejoin="round">
      {/* Contrast outline, so wires stay readable where they cross */}
      <path
        d={path}
        stroke={outline}
        strokeWidth={outlineW}
        fill="none"
        pathLength={revealing ? 1 : undefined}
        className={revealing ? 'velxio-reveal-wire' : undefined}
        style={drawStyle}
      />

      {/* Hover highlight (below wire) */}
      {!revealing && isHovered && !isSelected && (
        <path d={path} stroke={marker} strokeWidth="6" fill="none" opacity="0.2" />
      )}

      {/* Visible wire */}
      <path
        d={path}
        stroke={color}
        strokeWidth={strokeW}
        fill="none"
        opacity={revealing ? 1 : opacity}
        pathLength={revealing ? 1 : undefined}
        className={revealing ? 'velxio-reveal-wire' : undefined}
        style={drawStyle}
      />

      {/* Selection dashed highlight */}
      {!revealing && isSelected && (
        <path
          d={path}
          stroke={marker}
          strokeWidth="1.5"
          fill="none"
          strokeDasharray="6,4"
          opacity="0.6"
        />
      )}

      {/* Endpoint dots */}
      <circle
        cx={wire.start.x}
        cy={wire.start.y}
        r="3"
        fill={color}
        stroke="#1a1a1a"
        strokeWidth="1"
        className={revealing ? 'velxio-reveal-dot' : undefined}
        style={revealing ? { animationDelay: `${dotDelay}ms` } : undefined}
      />
      <circle
        cx={wire.end.x}
        cy={wire.end.y}
        r="3"
        fill={color}
        stroke="#1a1a1a"
        strokeWidth="1"
        className={revealing ? 'velxio-reveal-dot' : undefined}
        style={revealing ? { animationDelay: `${dotDelay}ms` } : undefined}
      />
    </g>
  );
};
