/**
 * VUMeter - Retro LED-style audio level display
 *
 * A realistic VU meter with variable segment brightness.
 * Segments near the peak are brightest, creating a smooth falloff effect.
 */

import { useMemo } from 'react';
import type { VUMeterData } from '../audio/types';
import './VUMeter.css';

interface VUMeterProps {
  /** VU meter data from audio worklet */
  data: VUMeterData | null;
  /** Number of LED segments (default 5) */
  segments?: number;
}

export function VUMeter({ data, segments = 5 }: VUMeterProps) {
  // Calculate the current level as a continuous value
  const level = useMemo(() => {
    if (!data) return 0;

    // Blend peak and RMS for responsive but smooth display
    const raw = (data.rms * 0.5) + (data.peak * 0.5);

    // Low threshold
    if (raw < 0.01) return 0;

    // Gentle curve - don't over-boost
    return Math.pow(raw, 0.7);
  }, [data]);

  const isClipping = data?.clipping ?? false;

  return (
    <div className="vu-meter" title="Audio Level">
      <div className="vu-meter-bar">
        {Array.from({ length: segments }, (_, i) => {
          // Each segment represents a range of the level
          const segmentThreshold = i / segments;
          const segmentTop = (i + 1) / segments;

          // Calculate brightness: full if level is above segment top,
          // partial if level is within segment, zero if below
          let brightness = 0;
          if (level >= segmentTop) {
            brightness = 1;
          } else if (level > segmentThreshold) {
            // Partial fill within this segment
            brightness = (level - segmentThreshold) / (segmentTop - segmentThreshold);
          }

          // Add subtle glow trail effect - segments below peak get slight brightness
          if (brightness === 0 && level > 0 && i < level * segments) {
            const distanceFromPeak = (level * segments) - i;
            brightness = Math.max(0, 0.3 - (distanceFromPeak * 0.1));
          }

          const isLit = brightness > 0.1;

          // Color coding: first 60% green, next 20% yellow, top 20% red
          const position = i / segments;
          let colorClass = 'green';
          if (position >= 0.8) colorClass = 'red';
          else if (position >= 0.6) colorClass = 'yellow';

          return (
            <div
              key={i}
              className={`vu-segment ${colorClass} ${isLit ? 'lit' : ''} ${isClipping && colorClass === 'red' ? 'clipping' : ''}`}
              style={{ '--segment-brightness': brightness } as React.CSSProperties}
            />
          );
        })}
      </div>
    </div>
  );
}
