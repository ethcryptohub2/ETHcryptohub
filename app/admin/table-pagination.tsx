'use client';

import { TABLE_PAGE_SIZE } from '../../lib/pagination';

export function TablePagination({
  page,
  total,
  label,
  onPageChange,
}: {
  page: number;
  total: number;
  label: string;
  onPageChange: (page: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / TABLE_PAGE_SIZE));
  const start = total === 0 ? 0 : (page - 1) * TABLE_PAGE_SIZE + 1;
  const end = Math.min(page * TABLE_PAGE_SIZE, total);

  return <nav className="subscription-pagination" aria-label={`${label} pagination`}>
    <span>Showing {start}–{end} of {total} {label}</span>
    <button type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>Previous</button>
    <span>Page {page} of {pageCount}</span>
    <button type="button" disabled={page >= pageCount} onClick={() => onPageChange(page + 1)}>Next</button>
  </nav>;
}
