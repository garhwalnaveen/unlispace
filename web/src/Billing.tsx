import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./components/ui/table";
import { NativeSelect } from "./components/ui/native-select";
import { Input } from "./components/ui/input";
import { Button } from "./components/ui/button";
import { useCallback, useMemo, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "./context";
import { billingCatalog, externalUrl, m2, type Checkout } from "./m2";
import { ErrorNotice, formatBytes, formatDate, Loading, Modal, useLoad } from "./ui";

import { UsageMeter } from "./Usage";

/** Formats minor currency units; USD reads "US$15.00" so it is unambiguous. */
export function formatMoney(minor: number, currency: string): string {
  const probe = new Intl.NumberFormat("en-US", { style: "currency", currency });
  const digits = probe.resolvedOptions().maximumFractionDigits ?? 2;
  const value = minor / 10 ** digits;
  if (currency === "USD") return `US$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  return probe.format(value);
}
export function Billing() {
  const { id = "" } = useParams();
  const { auth } = useAuth();
  const api = useMemo(() => m2(auth.api), [auth]);
  const load = useCallback(() => api.billing(id), [api, id]);
  const summary = useLoad(load);
  const catalog = useLoad(billingCatalog);
  const orgs = useLoad(auth.api.orgs);
  const org = orgs.data?.orgs.find((item) => item.id === id);
  const canManage = org?.role === "owner" || org?.role === "admin";
  const [invoicePage, setInvoicePage] = useState(0);
  const loadInvoices = useCallback(() => canManage ? api.invoices(id, invoicePage) : Promise.resolve({ invoices: [], nextPage: null }), [api, id, invoicePage, canManage]);
  const invoices = useLoad(loadInvoices);
  const [tier, setTier] = useState<Checkout["plan"]>("individual");
  const [cadence, setCadence] = useState<Checkout["cadence"]>("monthly");
  const [seats, setSeats] = useState(1);
  const [storageAddons, setStorageAddons] = useState(0);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  async function redirect(checkout: boolean) {
    setBusy(true); setError(undefined);
    try {
      const result = checkout ? await api.checkout(id, { plan: tier, cadence, seats: tier === "individual" ? 1 : seats, storageAddons }) : await api.portal(id);
      window.location.assign(externalUrl(result.url));
    } catch (reason) { setError(reason); setBusy(false); }
  }
  const billing = summary.data;
  const days = billing?.trialEndsAt == null ? null : Math.max(0, Math.ceil((billing.trialEndsAt - Date.now()) / 86_400_000));
  const selectedSeats = tier === "individual" ? 1 : seats;
  const prices = catalog.data?.prices;
  const total = prices ? selectedSeats * prices[tier][cadence].amount + storageAddons * prices.storage[cadence].amount : null;
  const amount = total !== null && prices && Number.isSafeInteger(total) ? formatMoney(total, prices[tier][cadence].currency) : null;
  const period = cadence === "annual" ? "year" : "month";
  function submit(event: FormEvent) { event.preventDefault(); void redirect(true); }
  return <>
    <header className="page-heading"><div><Link to="/">Your drives</Link><h1>Billing</h1><p className="muted">{org?.name || "Workspace subscription"}</p></div></header>
    <ErrorNotice error={summary.error || catalog.error || orgs.error || (!choosing && error)} />
    {Boolean(summary.error || catalog.error || orgs.error) && <Button onClick={() => { summary.reload(); catalog.reload(); orgs.reload(); }}>Try again</Button>}
    {summary.loading && <Loading>Loading subscription…</Loading>}
    {billing && <section className="panel" aria-labelledby="plan-title"><h2 id="plan-title">{billing.plan === "teams" ? "Teams" : "Individual"} plan</h2>
      <p>{billing.status}{days !== null && billing.state !== "paid" ? ` · ${days > 0 ? `${days} trial day${days === 1 ? "" : "s"} remaining` : "Trial ended"}` : ""}</p>
      <p className="muted small">{billing.seats} seat{billing.seats === 1 ? "" : "s"}</p>
      <UsageMeter {...billing} />
      {billing.trialPending && <p className="notice">Your trial has not started. It begins when your drive is ready.</p>}
      {days === 0 && !billing.writable && <p className="notice">Your trial has ended. Choose a plan to keep uploading. Your existing files remain readable.</p>}
      {canManage ? <div className="actions">
        <Button variant="default" disabled={busy} onClick={() => setChoosing(true)}>Choose a plan</Button>
        <Button disabled={busy} onClick={() => void redirect(false)}>Manage subscription</Button>
      </div> : <p className="muted small">An organization owner or admin can manage your subscription.</p>}
    </section>}
    {choosing && canManage && <Modal title="Choose a plan" onClose={() => { if (!busy) setChoosing(false); }}>
        <ErrorNotice error={error} />
        {catalog.loading && <Loading />}
        {catalog.data && <form className="stack" onSubmit={submit}>
          <label htmlFor="billing-plan">Plan</label><NativeSelect id="billing-plan" value={tier} disabled={busy} onChange={(event) => { const value = event.target.value as Checkout["plan"]; setTier(value); setSeats(catalog.data!.plans.find((plan) => plan.id === value)?.minSeats || 1); }}>
            {catalog.data.plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name} · {formatBytes(plan.bytesPerSeat)} per seat</option>)}
          </NativeSelect>
          <label htmlFor="billing-cadence">Billing period</label><NativeSelect id="billing-cadence" value={cadence} disabled={busy} onChange={(event) => setCadence(event.target.value as Checkout["cadence"])}><option value="monthly">Monthly</option><option value="annual">Annual</option></NativeSelect>
          {tier === "teams" && <><label htmlFor="billing-seats">Seats</label><Input id="billing-seats" type="number" max={catalog.data.plans.find((plan) => plan.id === tier)?.maxSeats} min={catalog.data.plans.find((plan) => plan.id === tier)?.minSeats || 1} step="1" required value={seats} disabled={busy} onChange={(event) => setSeats(Number(event.target.value))} /></>}
          <label htmlFor="billing-storage">Extra storage ({formatBytes(catalog.data.storageAddon.bytes)} each)</label><Input id="billing-storage" type="number" max={catalog.data.storageAddon.maxQuantity} min="0" step="1" required value={storageAddons} disabled={busy} onChange={(event) => setStorageAddons(Number(event.target.value))} />
          <section className="notice" aria-label="Checkout summary">
            <p><strong>{catalog.data.plans.find((plan) => plan.id === tier)?.name} · {cadence === "annual" ? "Annual" : "Monthly"} subscription</strong></p>
            <p>{tier === "individual" ? 1 : seats} seat{(tier === "individual" ? 1 : seats) === 1 ? "" : "s"} · {storageAddons} extra storage add-on{storageAddons === 1 ? "" : "s"}.</p>
            {amount ? <>
              <p data-testid="due-today"><strong>Due today: {amount}</strong>, plus applicable tax.</p>
              <p>{amount} per {period}, plus applicable tax. Renews automatically each {period}; cancel in Billing.</p>
              {catalog.data.checkoutEndsTrial && <p>Your card is charged {amount} today and your free trial ends now.</p>}
              {catalog.data.checkoutStartsImmediately && !catalog.data.checkoutEndsTrial && <p>Your subscription starts immediately.</p>}
              <p className="muted small">Final tax is calculated by Dodo Payments before you confirm. No payment is taken until then.</p>
            </> : <>
              <p>The amount due today, currency and applicable tax are shown in Dodo Payments before you confirm payment. No payment is taken by this button.</p>
              {catalog.data.checkoutStartsImmediately && <p>Paying starts your subscription immediately{catalog.data.checkoutEndsTrial ? " and ends any remaining free trial" : ""}. It renews automatically {cadence === "annual" ? "each year" : "each month"}; manage cancellation in Billing.</p>}
            </>}
          </section>{!catalog.data.checkoutAvailable && <p className="notice">Checkout is not available yet. Please try again later.</p>}<Button variant="default" disabled={busy || !catalog.data.checkoutAvailable}>{busy ? "Opening billing…" : amount ? `Continue to pay ${amount}` : `Review ${cadence === "annual" ? "annual" : "monthly"} checkout`}</Button>
        </form>}
    </Modal>}
      {canManage && <section className="panel" aria-labelledby="invoices-title"><h2 id="invoices-title">Invoices</h2><ErrorNotice error={invoices.error} />{Boolean(invoices.error) && <Button onClick={invoices.reload}>Retry invoices</Button>}{invoices.loading && <Loading />}
        {invoices.data?.invoices.length === 0 && <p className="muted">No invoices yet.</p>}
        {Boolean(invoices.data?.invoices.length) && <Table>
          <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Invoice</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Amount</TableHead></TableRow></TableHeader>
          <TableBody>{invoices.data?.invoices.map((invoice) => <TableRow key={invoice.paymentId}>
            <TableCell>{formatDate(Date.parse(invoice.createdAt))}</TableCell><TableCell><code>{invoice.paymentId}</code></TableCell><TableCell>{invoice.status}</TableCell>
            <TableCell className="text-right tabular-nums">{new Intl.NumberFormat(undefined, { style: "currency", currency: invoice.currency }).format(invoice.amount / 100)}</TableCell>
          </TableRow>)}</TableBody>
        </Table>}
        <div className="actions">{invoicePage > 0 && <Button disabled={invoices.loading} onClick={() => setInvoicePage((page) => page - 1)}>Previous invoices</Button>}{invoices.data?.nextPage != null && <Button disabled={invoices.loading} onClick={() => setInvoicePage(invoices.data!.nextPage!)}>Next invoices</Button>}</div>
      </section>}
  </>;
}
