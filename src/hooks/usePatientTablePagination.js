import { useState } from "react";

export function usePatientTablePagination(totalItems, resetKey) {
  const [pageSize, setPageSize] = useState(10);
  const [selection, setSelection] = useState({ resetKey, pageSize, page: 1 });
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = selection.resetKey === resetKey && selection.pageSize === pageSize
    ? Math.min(selection.page, totalPages) : 1;

  // Adjust this component's own state before rendering rows, preventing a stale
  // page flash on search/filter changes and retaining a clamp after data shrinks.
  if (selection.resetKey !== resetKey || selection.pageSize !== pageSize || selection.page !== currentPage) {
    setSelection({ resetKey, pageSize, page: currentPage });
  }

  return {
    pageSize, setPageSize, currentPage, totalPages,
    setCurrentPage: (page) => setSelection({
      resetKey, pageSize, page: Math.max(1, Math.min(page, totalPages)),
    }),
    startIndex: (currentPage - 1) * pageSize,
  };
}
