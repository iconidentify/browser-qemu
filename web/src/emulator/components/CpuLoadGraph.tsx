/**
 * CpuLoadGraph - LED dot-matrix CPU load history display
 *
 * A rack-equipment style LED bar graph: each column is one load sample,
 * newest on the right, scrolling left over time. Green through amber to
 * red as load climbs, matching the VU meter's palette.
 */

import './CpuLoadGraph.css';

interface CpuLoadGraphProps {
  /** Load history, oldest first, each value 0-1 */
  history: number[];
  /** Number of columns to display (default 16) */
  columns?: number;
  /** LED rows per column (default 8) */
  rows?: number;
}

export function CpuLoadGraph({ history, columns = 16, rows = 8 }: CpuLoadGraphProps) {
  // Right-align the history: newest sample in the last column.
  // Display curve lifts small loads so light activity still registers
  // a dot or two instead of disappearing.
  const samples = Array.from({ length: columns }, (_, i) => {
    const idx = history.length - columns + i;
    return idx >= 0 ? Math.pow(history[idx], 0.6) : 0;
  });

  return (
    <div className="cpu-graph" title="CPU load history">
      <div className="cpu-graph-columns">
        {samples.map((load, col) => (
          <div key={col} className="cpu-col">
            {Array.from({ length: rows }, (_, r) => {
              // Row 0 renders at the top; light from the bottom up
              const rowFromBottom = rows - 1 - r;
              const lit = load * rows > rowFromBottom + 0.5;
              // Top row red, next two amber, rest green
              const colorClass = rowFromBottom >= rows - 1
                ? 'red'
                : rowFromBottom >= rows - 3
                  ? 'amber'
                  : 'green';
              return (
                <span
                  key={r}
                  className={`cpu-dot ${colorClass}${lit ? ' lit' : ''}`}
                />
              );
            })}
          </div>
        ))}
      </div>
      <span className="cpu-graph-label">CPU</span>
    </div>
  );
}
