'use client';

import React from 'react';
import { getVisiblePageNumbers } from '../lib/pagination';

export interface PaginationProps {
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize?: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: number[];
  itemLabel?: string;
  className?: string;
  compact?: boolean;
}

export function Pagination({
  page,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 20, 25, 50, 100],
  itemLabel = 'items',
  className = '',
  compact = false,
}: PaginationProps) {
  if (totalItems <= 0 && totalPages <= 1) {
    return null;
  }

  const currentPage = Math.max(1, Math.min(page, Math.max(1, totalPages)));
  const visiblePages = getVisiblePageNumbers(currentPage, totalPages, compact ? 3 : 5);

  const startItem = totalItems === 0 ? 0 : pageSize ? (currentPage - 1) * pageSize + 1 : 1;
  const endItem = pageSize ? Math.min(currentPage * pageSize, totalItems) : totalItems;

  return (
    <nav
      className={`pagination-container ${className}`}
      aria-label={`${itemLabel} pagination`}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 12,
        padding: '12px 0',
        marginTop: 16,
        borderTop: '1px solid var(--surface-border, rgba(255, 255, 255, 0.08))',
        fontSize: 13,
      }}
    >
      <div
        className="pagination-summary muted"
        style={{ display: 'flex', alignItems: 'center', gap: 12 }}
      >
        <span>
          Showing <strong>{startItem}</strong>–<strong>{endItem}</strong> of <strong>{totalItems}</strong> {itemLabel}
        </span>
        {onPageSizeChange && pageSize && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, margin: 0, fontSize: 12 }}>
            <span className="muted">Show</span>
            <select
              value={pageSize}
              onChange={(e) => {
                const nextSize = Number(e.target.value);
                if (Number.isFinite(nextSize) && nextSize > 0) {
                  onPageSizeChange(nextSize);
                }
              }}
              style={{
                padding: '3px 8px',
                borderRadius: 4,
                fontSize: 12,
                background: 'var(--surface-subtle, rgba(255, 255, 255, 0.04))',
                border: '1px solid var(--surface-border, rgba(255, 255, 255, 0.12))',
                color: 'var(--text, #ffffff)',
              }}
            >
              {pageSizeOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div
        className="pagination-controls"
        style={{ display: 'flex', alignItems: 'center', gap: 4 }}
      >
        <button
          type="button"
          className="button-secondary"
          onClick={() => onPageChange(1)}
          disabled={currentPage <= 1}
          aria-label="Go to first page"
          title="First Page"
          style={{ padding: '6px 10px', fontSize: 12, minWidth: 32 }}
        >
          «
        </button>
        <button
          type="button"
          className="button-secondary"
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage <= 1}
          aria-label="Go to previous page"
          title="Previous Page"
          style={{ padding: '6px 10px', fontSize: 12, minWidth: 32 }}
        >
          ‹
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4, margin: '0 4px' }}>
          {visiblePages.map((pageNum, index) => {
            if (pageNum === 'ellipsis') {
              return (
                <span
                  key={`ellipsis-${index}`}
                  aria-hidden="true"
                  style={{ padding: '0 4px', color: 'var(--text-muted, #9ca3af)' }}
                >
                  …
                </span>
              );
            }

            const isCurrent = pageNum === currentPage;
            return (
              <button
                key={pageNum}
                type="button"
                className={isCurrent ? 'button' : 'button-secondary'}
                onClick={() => onPageChange(pageNum)}
                aria-current={isCurrent ? 'page' : undefined}
                aria-label={`Page ${pageNum}`}
                style={{
                  padding: '6px 10px',
                  fontSize: 12,
                  minWidth: 32,
                  fontWeight: isCurrent ? 700 : 400,
                  background: isCurrent ? 'var(--accent, #3b82f6)' : undefined,
                  color: isCurrent ? '#ffffff' : undefined,
                }}
              >
                {pageNum}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          className="button-secondary"
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage >= totalPages}
          aria-label="Go to next page"
          title="Next Page"
          style={{ padding: '6px 10px', fontSize: 12, minWidth: 32 }}
        >
          ›
        </button>
        <button
          type="button"
          className="button-secondary"
          onClick={() => onPageChange(totalPages)}
          disabled={currentPage >= totalPages}
          aria-label="Go to last page"
          title="Last Page"
          style={{ padding: '6px 10px', fontSize: 12, minWidth: 32 }}
        >
          »
        </button>
      </div>
    </nav>
  );
}
