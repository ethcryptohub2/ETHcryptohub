export const TABLE_PAGE_SIZE = 10;
export const SIGNALS_PAGE_SIZE = 20;
export const SCANNER_PAGE_SIZE = 25;
export const POSITIONS_PAGE_SIZE = 20;
export const HISTORY_PAGE_SIZE = 25;
export const ADMIN_COINS_PAGE_SIZE = 50;
export const ADMIN_USERS_PAGE_SIZE = 25;
export const NEWS_PAGE_SIZE = 12;
export const NOTIFICATIONS_PAGE_SIZE = 20;
export const AUDIT_LOGS_PAGE_SIZE = 50;

export interface PaginationState {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
}

export function calculatePagination(page: number, pageSize: number, totalItems: number): PaginationState {
  const safePageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const startIndex = (safePage - 1) * safePageSize;
  const endIndex = Math.min(startIndex + safePageSize, totalItems);

  return {
    page: safePage,
    pageSize: safePageSize,
    totalItems,
    totalPages,
    startIndex,
    endIndex,
  };
}

export function paginateArray<T>(items: T[], page: number, pageSize: number): { pageItems: T[]; pagination: PaginationState } {
  const pagination = calculatePagination(page, pageSize, items.length);
  const pageItems = items.slice(pagination.startIndex, pagination.endIndex);
  return { pageItems, pagination };
}

export function getVisiblePageNumbers(currentPage: number, totalPages: number, maxVisible = 5): (number | 'ellipsis')[] {
  if (totalPages <= maxVisible + 2) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const pages: (number | 'ellipsis')[] = [1];
  const halfWindow = Math.floor(maxVisible / 2);
  const start = Math.max(2, currentPage - halfWindow);
  const end = Math.min(totalPages - 1, currentPage + halfWindow);

  if (start > 2) {
    pages.push('ellipsis');
  }

  for (let i = start; i <= end; i++) {
    pages.push(i);
  }

  if (end < totalPages - 1) {
    pages.push('ellipsis');
  }

  pages.push(totalPages);
  return pages;
}
