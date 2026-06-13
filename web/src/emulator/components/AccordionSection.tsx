/**
 * AccordionSection - Collapsible section with header and content
 *
 * Features:
 * - Clickable header toggles open/closed state
 * - Chevron indicator rotates on open/close
 * - Optional badge in header (e.g., "1 of 3")
 * - Smooth expand/collapse animation
 */

import { useState, type ReactNode } from 'react';
import './AccordionSection.css';

interface AccordionSectionProps {
  /** Section title */
  title: string;
  /** Optional badge text (e.g., "(1 of 3)") */
  badge?: string;
  /** Whether section starts expanded */
  defaultOpen?: boolean;
  /** Section content */
  children: ReactNode;
  /** Optional CSS class for the section */
  className?: string;
}

export function AccordionSection({
  title,
  badge,
  defaultOpen = false,
  children,
  className = '',
}: AccordionSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className={`accordion-section ${isOpen ? 'open' : ''} ${className}`}>
      <button
        type="button"
        className="accordion-header"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
      >
        <span className="accordion-title">
          {title}
          {badge && <span className="accordion-badge">{badge}</span>}
        </span>
        <svg
          className="accordion-chevron"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
      </button>
      <div className="accordion-content">
        <div className="accordion-inner">{children}</div>
      </div>
    </div>
  );
}
