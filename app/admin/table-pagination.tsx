'use client';

import { TABLE_PAGE_SIZE } from '../../lib/pagination';
import { Pagination } from '../../components/pagination';

export function TablePagination({
  page,
  total,
  label,
  onPageChange,
  pageSize = TABLE_PAGE_SIZE,
}: {
  page: number;
  total: number;
  label: string;
  onPageChange: (page: number) => void;
  pageSize?: number;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <Pagination
      page={page}
      totalPages={pageCount}
      totalItems={total}
      pageSize={pageSize}
      onPageChange={onPageChange}
      itemLabel={label}
    />
  );
}
