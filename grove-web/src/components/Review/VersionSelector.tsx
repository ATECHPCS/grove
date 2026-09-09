import { useState, useRef, useEffect, useCallback } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { VersionOption } from './DiffReviewPage';

/** Above this many options, render the dropdown with a virtualized list. */
const VIRTUAL_THRESHOLD = 100;
/** Approximate rendered height of one .diff-version-option row. */
const ITEM_HEIGHT = 33;
/** Max visible height of the virtualized list (dropdown is capped at 300px). */
const MAX_LIST_HEIGHT = 264;

interface VersionSelectorProps {
  options: VersionOption[];
  selected: string;
  onChange: (id: string) => void;
  /** Optional muted hint pinned to the bottom of the dropdown (e.g. truncation notice). */
  footer?: React.ReactNode;
}

export function VersionSelector({ options, selected, onChange, footer }: VersionSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((o) => o.id === selected);
  const selectedIndex = options.findIndex((o) => o.id === selected);
  const virtualized = options.length > VIRTUAL_THRESHOLD;

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen]);

  const handleSelect = useCallback((id: string) => {
    onChange(id);
    setIsOpen(false);
  }, [onChange]);

  const Chevron = isOpen ? ChevronUp : ChevronDown;

  const renderOption = (opt: VersionOption) => (
    <button
      key={opt.id}
      className={`diff-version-option ${opt.id === selected ? 'selected' : ''}`}
      onClick={() => handleSelect(opt.id)}
    >
      {opt.label}
    </button>
  );

  return (
    <div className="diff-version-selector" ref={containerRef}>
      <button
        className={`diff-version-trigger ${isOpen ? 'open' : ''}`}
        onClick={() => setIsOpen((v) => !v)}
      >
        <span>{selectedOption?.label ?? selected}</span>
        <Chevron style={{ width: 12, height: 12, opacity: 0.6 }} />
      </button>

      {isOpen && (
        <div className="diff-version-dropdown">
          {virtualized ? (
            <Virtuoso
              style={{ height: Math.min(options.length * ITEM_HEIGHT, MAX_LIST_HEIGHT) }}
              totalCount={options.length}
              itemContent={(index) => {
                const opt = options[index];
                return (
                  <button
                    className={`diff-version-option ${opt.id === selected ? 'selected' : ''}`}
                    onClick={() => handleSelect(opt.id)}
                  >
                    {opt.label}
                  </button>
                );
              }}
              initialTopMostItemIndex={Math.max(0, selectedIndex)}
            />
          ) : (
            options.map(renderOption)
          )}
          {footer && <div className="diff-version-footer">{footer}</div>}
        </div>
      )}
    </div>
  );
}
