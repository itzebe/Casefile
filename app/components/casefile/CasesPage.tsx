import { useActionMutation, useActionQuery } from "@agent-native/core/client/use-action";
import { Link, useNavigate } from "react-router";
import { useState } from "react";

import { StatusPill } from "@/components/casefile/badges";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { DisputeCategory } from "@shared/casefile/types";

import { casePath } from "@/lib/casefile-paths";
import { cn } from "@/lib/utils";

interface CaseSummary {
  id: string;
  title: string;
  description: string;
  category: string;
  status: string;
  amountMinor: number | null;
  currency: string | null;
  createdAt: string;
  updatedAt: string;
  evidenceCount: number;
  extractedCount: number;
  claimCount: number;
  eventCount: number;
  confirmedCount: number;
}

function formatAmount(amountMinor: number | null, currency: string | null): string | null {
  if (amountMinor === null) return null;
  const value = (amountMinor / 100).toFixed(2);
  return currency ? `${value} ${currency}` : value;
}

interface SearchResult {
  results: {
    cases?: Array<{ id: string; title: string; status: string }>;
    documents?: Array<{ id: string; caseId: string; filename: string }>;
    passages?: Array<{ id: string; caseId: string; evidenceId: string; ref: string; filename: string; excerpt: string }>;
    findings?: Array<{ id: string; caseId: string; kind: string; statement: string }>;
    notes?: Array<{ id: string; caseId: string; body: string }>;
  };
  total: number;
}

function CaseRow({ item }: { item: CaseSummary }) {
  const amount = formatAmount(item.amountMinor, item.currency);
  const pending = item.evidenceCount - item.extractedCount;
  return (
    <Link
      to={casePath(item.id)}
      className="block rounded-lg border border-border p-4 transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{item.title}</span>
        <StatusPill value={item.status} />
        {item.category !== "uncategorized" ? (
          <span className="text-xs text-muted-foreground">{item.category.replace(/-/g, " ")}</span>
        ) : null}
        {amount ? <span className="text-xs font-medium">{amount}</span> : null}
      </div>
      {item.description ? (
        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{item.description}</p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          {item.evidenceCount} file{item.evidenceCount === 1 ? "" : "s"}
        </span>
        {pending > 0 ? <span className="text-amber-700 dark:text-amber-400">{pending} not read yet</span> : null}
        <span>
          {item.claimCount} claim{item.claimCount === 1 ? "" : "s"}
        </span>
        <span>
          {item.eventCount} event{item.eventCount === 1 ? "" : "s"}
        </span>
        {item.confirmedCount > 0 ? (
          <span className="text-emerald-700 dark:text-emerald-400">
            {item.confirmedCount} confirmed
          </span>
        ) : (
          <span>nothing confirmed yet</span>
        )}
      </div>
    </Link>
  );
}

export function CasesPage() {
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<DisputeCategory>("payment-dispute");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");

  const query = useActionQuery<{ cases: CaseSummary[] }>("list-cases", {});
  const search = useActionQuery<SearchResult>(
    "search-case",
    { query: searchTerm.trim(), limit: 20 },
    { enabled: searchTerm.trim().length >= 2 },
  );
  const create = useActionMutation<{ id: string }>("create-case", {
    onSuccess: (result) => {
      setShowCreate(false);
      setTitle("");
      setDescription("");
      setAmount("");
      setError(null);
      // Open the case the user just created. Without this the form simply
      // closes and the new case is invisible until a manual reload, which reads
      // as a control that did nothing.
      navigate(casePath(result.id));
    },
    onError: (err: Error) => setError(err.message),
  });

  const loadDemo = useActionMutation<{ caseId: string; created: boolean }>("load-demo-case", {
    onSuccess: (result) => {
      setError(null);
      navigate(casePath(result.caseId));
    },
    onError: (err: Error) => setError(err.message),
  });

  const loadCourtDemo = useActionMutation<{ caseId: string; created: boolean }>("load-demo-case", {
    onSuccess: (result) => {
      setError(null);
      navigate(casePath(result.caseId));
    },
    onError: (err: Error) => setError(err.message),
  });

  const cases = query.data?.cases ?? [];

  const submit = () => {
    if (!title.trim()) {
      setError("Give the case a name so you can find it later.");
      return;
    }
    const parsedAmount = amount.trim() ? Number(amount.replace(/[^0-9.]/g, "")) : null;
    if (amount.trim() && (!Number.isFinite(parsedAmount) || parsedAmount === null)) {
      setError("The amount needs to be a number, for example 249.99.");
      return;
    }
    create.mutate({
      title: title.trim(),
      description: description.trim(),
      category,
      ...(parsedAmount !== null && parsedAmount >= 0
        ? { amountMinor: Math.round(parsedAmount * 100), currency: currency.toUpperCase() }
        : {}),
    });
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Cases</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A case holds the documents for one dispute. Everything the app states is traced back to
          those documents, and nothing is confirmed until you confirm it.
        </p>
      </header>

      <div className="mb-6 flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {cases.length} case{cases.length === 1 ? "" : "s"}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => loadDemo.mutate({})}
            disabled={loadDemo.isPending}
            data-testid="load-demo-case"
          >
            {loadDemo.isPending ? "Loading demo…" : "Load payment demo"}
          </Button>
          <Button
            variant="outline"
            onClick={() => loadCourtDemo.mutate({ scenario: "court" })}
            disabled={loadCourtDemo.isPending}
            data-testid="load-court-demo-case"
          >
            {loadCourtDemo.isPending ? "Loading demo…" : "Load court demo"}
          </Button>
          <Button onClick={() => setShowCreate((open) => !open)} variant={showCreate ? "outline" : "default"}>
            {showCreate ? "Cancel" : "New case"}
          </Button>
        </div>
      </div>

      {showCreate ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base">Open a case</CardTitle>
            <CardDescription>
              You can change any of this later. The name is the only required field.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="case-title">Case name</Label>
              <Input
                id="case-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Unauthorised card charge, March 2024"
                maxLength={200}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="case-description">What is being disputed</Label>
              <textarea
                id="case-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
                maxLength={5000}
                className={cn(
                  "flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs",
                  "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                )}
                placeholder="In your own words. This is context, not evidence."
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="case-category">Category</Label>
                <select
                  id="case-category"
                  value={category}
                  onChange={(event) => setCategory(event.target.value as DisputeCategory)}
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs"
                >
                  {[
                    "payment-dispute",
                    "chargeback",
                    "unauthorized-transaction",
                    "contract-dispute",
                    "service-dispute",
                    "refund",
                    "fraud",
                    "uncategorized",
                    "other",
                  ].map((value) => (
                    <option key={value} value={value}>
                      {value.replace(/-/g, " ")}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="case-amount">Disputed amount</Label>
                <Input
                  id="case-amount"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="249.99"
                  inputMode="decimal"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="case-currency">Currency</Label>
                <Input
                  id="case-currency"
                  value={currency}
                  onChange={(event) => setCurrency(event.target.value.toUpperCase().slice(0, 3))}
                  maxLength={3}
                />
              </div>
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <div className="flex items-center gap-3">
              <Button onClick={submit} disabled={create.isPending}>
                {create.isPending ? "Creating…" : "Create case"}
              </Button>
              <span className="text-xs text-muted-foreground">
                Nothing here is sent to a model.
              </span>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="mb-6 space-y-2">
        <Label htmlFor="case-search">Search your cases</Label>
        <Input
          id="case-search"
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
          placeholder="Search case titles, documents, passages, findings and notes…"
          data-testid="case-search-input"
        />
        <p className="text-xs text-muted-foreground">
          Searches only your own cases. Results link straight to the document, passage, finding or
          note they came from.
        </p>
      </div>

      {searchTerm.trim().length >= 2 ? (
        <Card className="mb-6" data-testid="search-results">
          <CardHeader>
            <CardTitle className="text-base">Search results</CardTitle>
            <CardDescription>
              {search.isFetching
                ? "Searching…"
                : `${search.data?.total ?? 0} match(es) for “${searchTerm.trim()}”.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {(search.data?.results.cases ?? []).map((item) => (
              <Link key={`c-${item.id}`} to={casePath(item.id)} className="block underline">
                Case: {item.title}
              </Link>
            ))}
            {(search.data?.results.documents ?? []).map((item) => (
              <Link key={`d-${item.id}`} to={casePath(item.caseId)} className="block underline">
                Document: {item.filename}
              </Link>
            ))}
            {(search.data?.results.passages ?? []).map((item) => (
              <Link key={`p-${item.id}`} to={casePath(item.caseId)} className="block">
                <span className="underline">{item.filename}</span>{" "}
                <span className="text-muted-foreground">({item.ref})</span> — {item.excerpt}
              </Link>
            ))}
            {(search.data?.results.findings ?? []).map((item) => (
              <Link key={`f-${item.id}`} to={casePath(item.caseId)} className="block">
                <span className="text-muted-foreground">{item.kind}:</span>{" "}
                <span className="underline">{item.statement}</span>
              </Link>
            ))}
            {(search.data?.results.notes ?? []).map((item) => (
              <Link key={`n-${item.id}`} to={casePath(item.caseId)} className="block">
                <span className="text-muted-foreground">Note:</span>{" "}
                <span className="underline">{item.body}</span>
              </Link>
            ))}
            {search.data && search.data.total === 0 ? (
              <p className="text-muted-foreground">Nothing matched that term.</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {query.isPending ? (
        <p className="text-sm text-muted-foreground">Loading cases…</p>
      ) : query.isError ? (
        <p className="text-sm text-destructive">
          Cases could not be loaded: {(query.error as Error).message}
        </p>
      ) : cases.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No cases yet</CardTitle>
            <CardDescription>
              Open a case, then add the documents you already have: a receipt, a bank statement, a
              contract, or your correspondence with the other side. Or load the demonstration case
              to see a finished investigation first.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => loadDemo.mutate({})}
                disabled={loadDemo.isPending}
                data-testid="load-demo-case-empty"
              >
                {loadDemo.isPending ? "Loading demo…" : "Load the payment demo"}
              </Button>
              <Button
                variant="outline"
                onClick={() => loadCourtDemo.mutate({ scenario: "court" })}
                disabled={loadCourtDemo.isPending}
                data-testid="load-court-demo-case-empty"
              >
                {loadCourtDemo.isPending ? "Loading demo…" : "Load the court demo"}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              The payment demo is five synthetic documents about a disputed refund. The court demo
              is six synthetic documents that separate a party&apos;s allegation from a court&apos;s
              finding. Neither represents a real party, payment, or proceeding.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {cases.map((item) => (
            <CaseRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

export default CasesPage;
