import { useCallback, useMemo, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "./context";
import { billingCatalog, externalUrl, m2, type Checkout } from "./m2";
import { ErrorNotice, formatBytes, formatDate, Loading, useLoad } from "./ui";

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
  function submit(event: FormEvent) { event.preventDefault(); void redirect(true); }
  return <>
    <header className="page-heading"><div><Link to="/">Your drives</Link><h1>Billing</h1><p className="muted">{org?.name || "Organization subscription"}</p></div></header>
    <ErrorNotice error={summary.error || catalog.error || orgs.error || error} />
    {Boolean(summary.error || catalog.error || orgs.error) && <button onClick={() => { summary.reload(); catalog.reload(); orgs.reload(); }}>Try again</button>}
    {summary.loading && <Loading>Loading subscription…</Loading>}
    {billing && <section className="panel billing-summary" aria-labelledby="plan-title"><h2 id="plan-title">{billing.plan === "teams" ? "Teams" : "Individual"} plan</h2>
      <p>{billing.status}{days !== null && billing.state !== "paid" ? ` · ${days > 0 ? `${days} trial day${days === 1 ? "" : "s"} remaining` : "Trial ended"}` : ""}</p>
      <dl><dt>Seats</dt><dd>{billing.seats}</dd><dt>Storage</dt><dd>{formatBytes(billing.usedBytes)} of {formatBytes(billing.quotaBytes)}</dd></dl>
      {days === 0 && !billing.writable && <p className="notice">Your trial has ended. Choose a plan to keep uploading. Your existing files remain readable.</p>}
      {canManage && <button disabled={busy} onClick={() => void redirect(false)}>Manage subscription</button>}
    </section>}
    <div className="settings-layout">
      <section className="panel" aria-labelledby="choose-plan-title"><h2 id="choose-plan-title">Choose a plan</h2>
        {catalog.loading && <Loading />}
        {catalog.data && (canManage ? <form className="stack" onSubmit={submit}>
          <label htmlFor="billing-plan">Plan</label><select id="billing-plan" value={tier} disabled={busy} onChange={(event) => { const value = event.target.value as Checkout["plan"]; setTier(value); setSeats(catalog.data!.plans.find((plan) => plan.id === value)?.minSeats || 1); }}>
            {catalog.data.plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name} · {formatBytes(plan.bytesPerSeat)} per seat</option>)}
          </select>
          <label htmlFor="billing-cadence">Billing period</label><select id="billing-cadence" value={cadence} disabled={busy} onChange={(event) => setCadence(event.target.value as Checkout["cadence"])}><option value="monthly">Monthly</option><option value="annual">Annual</option></select>
          {tier === "teams" && <><label htmlFor="billing-seats">Seats</label><input id="billing-seats" type="number" max={catalog.data.plans.find((plan) => plan.id === tier)?.maxSeats} min={catalog.data.plans.find((plan) => plan.id === tier)?.minSeats || 1} step="1" required value={seats} disabled={busy} onChange={(event) => setSeats(Number(event.target.value))} /></>}
          <label htmlFor="billing-storage">Extra storage ({formatBytes(catalog.data.storageAddon.bytes)} each)</label><input id="billing-storage" type="number" max={catalog.data.storageAddon.maxQuantity} min="0" step="1" required value={storageAddons} disabled={busy} onChange={(event) => setStorageAddons(Number(event.target.value))} />
          <p className="muted small">Review the final price and payment terms in Dodo Payments before purchasing.</p>{!catalog.data.checkoutAvailable && <p className="notice">Checkout is not available yet. Please try again later.</p>}<button className="primary" disabled={busy || !catalog.data.checkoutAvailable}>{busy ? "Opening billing…" : "Continue to checkout"}</button>
        </form> : <p className="muted">An organization owner or admin can manage your subscription.</p>)}
      </section>
      {canManage && <section aria-labelledby="invoices-title"><h2 id="invoices-title">Invoices</h2><ErrorNotice error={invoices.error} />{Boolean(invoices.error) && <button onClick={invoices.reload}>Retry invoices</button>}{invoices.loading && <Loading />}
        {invoices.data?.invoices.length === 0 && <p className="muted">No invoices yet.</p>}
        <ul className="key-list">{invoices.data?.invoices.map((invoice) => <li key={invoice.paymentId}><strong>{formatDate(Date.parse(invoice.createdAt))}</strong><p>{new Intl.NumberFormat(undefined, { style: "currency", currency: invoice.currency }).format(invoice.amount / 100)} · {invoice.status}</p><code>{invoice.paymentId}</code></li>)}</ul><div className="actions">{invoicePage > 0 && <button disabled={invoices.loading} onClick={() => setInvoicePage((page) => page - 1)}>Previous invoices</button>}{invoices.data?.nextPage != null && <button disabled={invoices.loading} onClick={() => setInvoicePage(invoices.data!.nextPage!)}>Next invoices</button>}</div>
      </section>}
    </div>
  </>;
}
