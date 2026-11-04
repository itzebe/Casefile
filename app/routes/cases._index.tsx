import CasesPage from "@/components/casefile/CasesPage";

export function meta() {
  return [{ title: "Cases - Casefile" }];
}

export default function CasesIndexRoute() {
  return <CasesPage />;
}
