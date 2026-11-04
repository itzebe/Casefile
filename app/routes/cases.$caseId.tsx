import { useParams } from "react-router";

import CaseWorkspace from "@/components/casefile/CaseWorkspace";

export function meta() {
  return [{ title: "Case - Casefile" }];
}

export default function CaseDetailRoute() {
  const { caseId } = useParams<{ caseId: string }>();
  if (!caseId) {
    return <p className="p-8 text-sm text-muted-foreground">No case was specified.</p>;
  }
  return <CaseWorkspace caseId={caseId} />;
}
