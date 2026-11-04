/** Route paths for the CASEFILE case workspace. */
export const CASES_PATH = "/cases";

export function casePath(caseId: string): string {
  return `${CASES_PATH}/${encodeURIComponent(caseId)}`;
}
