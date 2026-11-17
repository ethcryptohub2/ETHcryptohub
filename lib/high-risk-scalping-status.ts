export function formatSignalStatusText(value: string | null | undefined) {
  if (value === null || value === undefined || value === '') return 'UNKNOWN';
  return String(value).replace(/_/g, ' ');
}
