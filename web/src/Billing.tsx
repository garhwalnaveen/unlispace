import { NativeSelect } from "./components/ui/native-select";
import { Input } from "./components/ui/input";
import { Button } from "./components/ui/button";
import { ArrowUpRight, ShieldCheck, TriangleAlert } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { useAuth } from "./context";
import { billingCatalog, externalUrl, type BillingCatalog, type BillingSummary, type Checkout } from "./billing-data";
import { formatDay, formatStorage, PageHeader, Section } from "./settings/parts";
import { ErrorNotice, Loading, Modal, useLoad } from "./ui";

import { UsageMeter } from "./Usage";

/** Formats minor currency units; USD reads "US$15.00" so it is unambiguous. */
export function formatMoney(minor: number, currency: string): string {
  const probe = new Intl.NumberFormat("en-US", { style: "currency", currency });
  const digits = probe.resolvedOptions().maximumFractionDigits ?? 2;
  const value = minor / 10 ** digits;
  if (currency === "USD") return `US$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  return probe.format(value);
}

/** Fields the billing summary returns beyond the shared type (cloud/api/src/billing.ts). */
type Summary = BillingSummary & { cadence?: "monthly" | "annual" | null; currentPeriodEnd?: number | null; cancelAtPeriodEnd?: boolean };
type Tone = "good" | "warn" | "";
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The plan's state in plain words: a short badge, one sentence, and, when changes are paused, the reassurance to lead with. */
export function planStatus(billing: Summary, now = Date.now()): { badge: string; tone: Tone; line: string; paused?: { title: string; text: string } } {
  const waiting = ["past_due", "on_hold", "paused"].includes(billing.status);
  if (billing.state === "paid") {
    if (billing.status === "past_due") return { badge: "Payment needs attention", tone: "warn", line: "Your files are safe and everything still works. The last payment didn't go through; update your payment method to keep it that way." };
    const cadence = billing.cadence === "annual" ? "Billed yearly" : billing.cadence === "monthly" ? "Billed monthly" : "";
    const until = billing.currentPeriodEnd ? formatDay(billing.currentPeriodEnd) : null;
    if (billing.cancelAtPeriodEnd) return { badge: "Ending", tone: "warn", line: until ? `Your plan ends on ${until} and won't renew. Your files stay readable after that.` : "Your plan won't renew. Your files stay readable after it ends." };
    return { badge: "Active", tone: "good", line: [cadence, until && `renews on ${until}`].filter(Boolean).join(", ").replace(/^r/, "R") || "Your plan is active." };
  }
  if (billing.state === "trial_active" && billing.trialEndsAt != null) {
    const days = Math.max(1, Math.ceil((billing.trialEndsAt - now) / 86_400_000));
    return { badge: "Free trial", tone: "good", line: `${plural(days, "day")} left in your free trial. It ends on ${formatDay(billing.trialEndsAt)}; choose a plan before then to keep uploading.` };
  }
  if (billing.state === "provisioning" || billing.trialPending) return { badge: "Trial not started", tone: "", line: "Your free trial starts when your first drive is ready." };
  if (billing.status === "pending") return { badge: "Confirming payment", tone: "", line: "Your payment is being confirmed. This page updates once it goes through." };
  if (waiting) return { badge: "Payment needs attention", tone: "warn", line: "Your subscription is on hold.", paused: { title: "Your files are safe and readable", text: "Uploads and changes are paused until the payment is sorted out. Update your payment method to resume." } };
  const trial = billing.status === "trialing";
  return {
    badge: trial ? "Trial ended" : "No active plan", tone: "warn",
    line: trial ? "Your free trial has ended." : "Your subscription has ended.",
    paused: { title: trial ? "Your trial has ended" : "Your subscription has ended", text: "Your files are safe and readable; uploads and changes are paused until you choose a plan." },
  };
}

export function Billing() {
  const { id = "" } = useParams();
  const { auth } = useAuth();
  const load = useCallback(() => auth.api.billing.summary(id) as Promise<Summary>, [auth, id]);
  const summary = useLoad(load);
  const catalog = useLoad(billingCatalog);
  const orgs = useLoad(auth.api.orgs);
  const org = orgs.data?.orgs.find((item) => item.id === id);
  const canManage = org?.role === "owner" || org?.role === "admin";
  const [invoicePage, setInvoicePage] = useState(0);
  const loadInvoices = useCallback(() => canManage ? auth.api.billing.invoices(id, invoicePage) : Promise.resolve({ invoices: [], nextPage: null }), [auth, id, invoicePage, canManage]);
  const invoices = useLoad(loadInvoices);
  const [choosing, setChoosing] = useState<Checkout["plan"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  async function redirect(checkout?: Checkout) {
    setBusy(true); setError(undefined);
    try {
      const result = checkout ? await auth.api.billing.checkout(id, checkout) : await auth.api.billing.portal(id);
      window.location.assign(externalUrl(result.url));
    } catch (reason) { setError(reason); setBusy(false); }
  }
  const billing = summary.data;
  // A live subscription is changed in the billing portal; checkout is only for workspaces without one.
  const hasSubscription = Boolean(billing && ["active", "past_due", "on_hold", "paused", "pending"].includes(billing.status));
  const hasCustomer = Boolean(billing && billing.status !== "trialing");
  const status = billing ? planStatus(billing) : null;
  const planName = (plan: string) => catalog.data?.plans.find((item) => item.id === plan)?.name ?? (plan === "teams" ? "Teams" : "Individual");
  const portal = <Button disabled={busy} onClick={() => void redirect()}>Manage payment method<ArrowUpRight aria-hidden="true" /></Button>;
  return <>
    <PageHeader title="Plan and billing" description={org ? `What ${org.name} is on, how much storage it uses, and its invoices.` : "Your workspace's plan, storage and invoices."} />
    <ErrorNotice error={summary.error || catalog.error || orgs.error || (!choosing && error)} />
    {Boolean(summary.error || catalog.error || orgs.error) && <Button onClick={() => { summary.reload(); catalog.reload(); orgs.reload(); }}>Try again</Button>}
    {summary.loading && <Loading>Loading your plan…</Loading>}
    {billing && status && <>
      {status.paused && <div className="st-callout" role="status">
        <ShieldCheck aria-hidden="true" />
        <div><strong>{status.paused.title}</strong><p>{status.paused.text}</p></div>
      </div>}
      <section className="st-card" aria-labelledby="plan-title"><div className="st-card-body" style={{ paddingTop: 20 }}>
        <div className="st-plan">
          <div>
            <h2 id="plan-title">{planName(billing.plan)} plan<span className={`st-badge ${status.tone}`}>{status.tone === "warn" && <TriangleAlert aria-hidden="true" size={12} />}{status.badge}</span></h2>
            <p>{status.line}</p>
            {billing.plan === "teams" && <p>{plural(billing.seats, "seat")}{billing.storageAddons > 0 ? `, ${plural(billing.storageAddons, "storage add-on")}` : ""}</p>}
          </div>
          {canManage && <div className="st-actions">
            {hasCustomer && portal}
            {!hasSubscription && <Button variant="default" disabled={busy} onClick={() => { setError(undefined); setChoosing(billing.plan); }}>Choose a plan</Button>}
          </div>}
        </div>
        {canManage && hasCustomer && <p className="st-help" style={{ marginTop: 8 }}>Manage payment method opens the secure billing portal in this tab.</p>}
        {!canManage && orgs.data && <p className="st-help" style={{ marginTop: 8 }}>Only owners and admins of this workspace can change the plan.</p>}
        <hr className="st-divider" />
        <UsageMeter {...billing} />
      </div></section>
      {canManage && catalog.data && catalog.data.plans.length > 0 && <Section title="Plans" labelledBy="plans-title"
        description={hasSubscription ? "You already have a subscription. To switch plans or change seats, use Manage payment method." : "Pick the one that fits. You confirm the price before anything is charged."}>
        <div className="st-card-body">
          <div className="st-plans">{catalog.data.plans.map((plan) => {
            const price = catalog.data!.prices?.[plan.id];
            const current = billing.state === "paid" && billing.plan === plan.id;
            const solo = plan.maxSeats === 1;
            return <article key={plan.id} className={`st-plan-option ${current ? "current" : ""}`} aria-label={`${plan.name} plan`}>
              <h3>{plan.name}{current && <span className="st-badge good">Current plan</span>}</h3>
              <p>{solo ? "For one person." : plan.minSeats > 1 ? `For teams, from ${plan.minSeats} seats.` : "For teams; add a seat for each person."}</p>
              {price && <p className="price">{formatMoney(price.monthly.amount, price.monthly.currency)} <span>{solo ? "a month" : "per seat a month"}</span></p>}
              {price && <p>or {formatMoney(price.annual.amount, price.annual.currency)} {solo ? "a year" : "per seat a year"}</p>}
              <p>{formatStorage(plan.bytesPerSeat)} of storage{solo ? "" : " per seat"}</p>
              {!hasSubscription && <Button disabled={busy} aria-label={`Choose ${plan.name}`} onClick={() => { setError(undefined); setChoosing(plan.id); }}>Choose {plan.name}</Button>}
            </article>;
          })}</div>
          {catalog.data.storageAddon.maxQuantity > 0 && <p className="st-help" style={{ marginTop: 12 }}>
            Need more room? Add storage in blocks of {formatStorage(catalog.data.storageAddon.bytes)}{catalog.data.prices ? `, ${formatMoney(catalog.data.prices.storage.monthly.amount, catalog.data.prices.storage.monthly.currency)} a month each` : ""}.
          </p>}
        </div>
      </Section>}
    </>}
    {choosing && canManage && <Modal title="Choose a plan" onClose={() => { if (!busy) setChoosing(null); }}>
      <ErrorNotice error={error} />
      {catalog.loading && <Loading />}
      {catalog.data && <CheckoutForm catalog={catalog.data} initial={choosing} busy={busy} onSubmit={(checkout) => void redirect(checkout)} />}
    </Modal>}
    {canManage && <Section title="Invoices" labelledBy="invoices-title">
      <ErrorNotice error={invoices.error} />
      {Boolean(invoices.error) && <div className="st-card-body"><Button onClick={invoices.reload}>Retry invoices</Button></div>}
      {invoices.loading && <div className="st-card-body"><Loading /></div>}
      {invoices.data?.invoices.length === 0 && <div className="st-card-body"><p className="st-help">No invoices yet. They appear here after your first payment.</p></div>}
      {Boolean(invoices.data?.invoices.length) && <div className="st-scroll"><table className="st-table">
        <thead><tr><th scope="col">Date</th><th scope="col">Reference</th><th scope="col">Status</th><th scope="col">Amount</th></tr></thead>
        <tbody>{invoices.data?.invoices.map((invoice) => <tr key={invoice.paymentId}>
          <td>{formatDay(Date.parse(invoice.createdAt))}</td>
          <td><span className="st-mono">{invoice.paymentId}</span></td>
          <td>{invoice.status ? invoice.status[0].toUpperCase() + invoice.status.slice(1).replaceAll("_", " ") : ""}</td>
          <td className="num">{formatMoney(invoice.amount, invoice.currency)}</td>
        </tr>)}</tbody>
      </table></div>}
      {(invoicePage > 0 || invoices.data?.nextPage != null) && <div className="st-card-foot st-actions">
        {invoicePage > 0 && <Button size="sm" disabled={invoices.loading} onClick={() => setInvoicePage((page) => page - 1)}>Previous invoices</Button>}
        {invoices.data?.nextPage != null && <Button size="sm" disabled={invoices.loading} onClick={() => setInvoicePage(invoices.data!.nextPage!)}>Next invoices</Button>}
      </div>}
    </Section>}
  </>;
}

function CheckoutForm({ catalog, initial, busy, onSubmit }: { catalog: BillingCatalog; initial: Checkout["plan"]; busy: boolean; onSubmit: (checkout: Checkout) => void }) {
  const start = catalog.plans.find((plan) => plan.id === initial) ?? catalog.plans[0];
  const [tier, setTier] = useState<Checkout["plan"]>(start?.id ?? "individual");
  const [cadence, setCadence] = useState<Checkout["cadence"]>("monthly");
  const [seats, setSeats] = useState(start?.minSeats || 1);
  const [storageAddons, setStorageAddons] = useState(0);
  const plan = catalog.plans.find((item) => item.id === tier);
  const selectedSeats = tier === "individual" ? 1 : seats;
  const prices = catalog.prices;
  const total = prices ? selectedSeats * prices[tier][cadence].amount + storageAddons * prices.storage[cadence].amount : null;
  const amount = total !== null && prices && Number.isSafeInteger(total) ? formatMoney(total, prices[tier][cadence].currency) : null;
  const period = cadence === "annual" ? "year" : "month";
  function submit(event: FormEvent) { event.preventDefault(); onSubmit({ plan: tier, cadence, seats: selectedSeats, storageAddons }); }
  return <form className="st-form st-dialog" onSubmit={submit}>
    <div className="st-field"><label htmlFor="billing-plan">Plan</label><NativeSelect id="billing-plan" value={tier} disabled={busy} onChange={(event) => { const value = event.target.value as Checkout["plan"]; setTier(value); setSeats(catalog.plans.find((item) => item.id === value)?.minSeats || 1); }}>
      {catalog.plans.map((item) => <option key={item.id} value={item.id}>{item.name} · {formatStorage(item.bytesPerSeat)}{item.maxSeats === 1 ? "" : " per seat"}</option>)}
    </NativeSelect></div>
    <div className="st-field"><label htmlFor="billing-cadence">Billing period</label><NativeSelect id="billing-cadence" value={cadence} disabled={busy} onChange={(event) => setCadence(event.target.value as Checkout["cadence"])}><option value="monthly">Monthly</option><option value="annual">Yearly</option></NativeSelect></div>
    {tier === "teams" && <div className="st-field"><label htmlFor="billing-seats">Seats</label><Input id="billing-seats" type="number" max={plan?.maxSeats} min={plan?.minSeats || 1} step="1" required value={seats} disabled={busy} onChange={(event) => setSeats(Number(event.target.value))} /><p className="st-help">One seat for each person, including you.</p></div>}
    {catalog.storageAddon.maxQuantity > 0 && <div className="st-field"><label htmlFor="billing-storage">Extra storage ({formatStorage(catalog.storageAddon.bytes)} each)</label><Input id="billing-storage" type="number" max={catalog.storageAddon.maxQuantity} min="0" step="1" required value={storageAddons} disabled={busy} onChange={(event) => setStorageAddons(Number(event.target.value))} /></div>}
    <section className="st-summary" aria-label="Checkout summary">
      <p><strong>{plan?.name} · {cadence === "annual" ? "Yearly" : "Monthly"} subscription</strong></p>
      <p>{plural(selectedSeats, "seat")} · {formatStorage(selectedSeats * (plan?.bytesPerSeat ?? 0) + storageAddons * catalog.storageAddon.bytes)} of storage in total.</p>
      {amount ? <>
        <p data-testid="due-today"><strong>Due today: {amount}</strong>, plus applicable tax.</p>
        <p>{amount} per {period}, plus applicable tax. Renews automatically each {period}; cancel in Billing.</p>
        {catalog.checkoutEndsTrial && <p>Your card is charged {amount} today and your free trial ends now.</p>}
        {catalog.checkoutStartsImmediately && !catalog.checkoutEndsTrial && <p>Your subscription starts immediately.</p>}
        <p className="st-help">Final tax is calculated by Dodo Payments before you confirm. No payment is taken until then.</p>
      </> : <>
        <p>The amount due today, currency and applicable tax are shown in Dodo Payments before you confirm payment. No payment is taken by this button.</p>
        {catalog.checkoutStartsImmediately && <p>Paying starts your subscription immediately{catalog.checkoutEndsTrial ? " and ends any remaining free trial" : ""}. It renews automatically {cadence === "annual" ? "each year" : "each month"}; manage cancellation in Billing.</p>}
      </>}
    </section>
    {!catalog.checkoutAvailable && <p className="notice">Checkout is not available yet. Please try again later.</p>}
    <div className="st-actions end"><Button variant="default" disabled={busy || !catalog.checkoutAvailable}>{busy ? "Opening checkout…" : amount ? `Continue to pay ${amount}` : `Review ${cadence === "annual" ? "yearly" : "monthly"} checkout`}<ArrowUpRight aria-hidden="true" /></Button></div>
  </form>;
}
