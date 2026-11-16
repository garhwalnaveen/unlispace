import { Link } from "react-router-dom";
import { Code2, FolderOpen, GitFork, Globe, History, Users, type LucideIcon } from "lucide-react";
import { Button } from "./components/ui/button";
import { useAuth } from "./context";
import { formatMoney } from "./Billing";
import { billingCatalog, type BillingCatalog } from "./billing-data";
import { OrbitMark } from "./OrbitMark";
import { useLoad } from "./ui";
import "./landing.css";

export function LandingNavigation() {
  return <nav className="marketing-nav" aria-label="Page sections">
    <a href="#features">Features</a>
    <a href="#plans">Plans</a>
    <a href="#faq">Questions</a>
  </nav>;
}

const features: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: FolderOpen, title: "Drives in Finder", body: "The Mac app mounts each drive as a volume. A file downloads when you open it, and you can keep a whole drive available offline." },
  { icon: History, title: "Version history", body: "Every save is kept as a version. Open a file's history in the browser to download or restore an earlier one." },
  { icon: Globe, title: "Browser access", body: "Browse, upload and download from any browser when you are away from your Mac." },
  { icon: Code2, title: "S3-compatible API", body: "Create access keys limited to specific drives, read-only or read-write, and point existing S3 tools and scripts at them." },
  { icon: GitFork, title: "Forks", body: "Fork a drive to get an independent copy. Unchanged data is shared with the original, so a fork only stores what you change." },
  { icon: Users, title: "Teams", body: "Invite people by email as admin, member or viewer. Everyone in the workspace sees the same drives." },
];

const faq = [
  { q: "What do I need to use Orbit?", a: "A browser is enough to browse, upload and download. Mounting drives in Finder needs the Orbit app on macOS 14 or later. Scripts and other tools connect with any S3 client." },
  { q: "Does the Mac app download all my files?", a: "No. Files stay in the cloud until you open them. To keep a local copy, mark a drive as available offline." },
  { q: "Can scripts or AI agents read and write files?", a: "Yes, through the S3-compatible API. Each access key is limited to the drives and the access level you choose, and can be revoked at any time." },
  { q: "What happens to my files if my trial or subscription ends?", a: "They stay readable and downloadable. Uploads resume when you choose a plan." },
  { q: "Can I get a deleted or overwritten file back?", a: "Yes. Deleting or overwriting a file adds a new version; earlier versions stay in the file's history." },
];

const storage = (bytes: number) => (bytes >= 1e12 ? `${bytes / 1e12} TB` : `${bytes / 1e9} GB`);

function Plans({ catalog, start }: { catalog: BillingCatalog | undefined; start: string }) {
  const plan = (id: "individual" | "teams") => catalog?.plans.find((p) => p.id === id);
  const price = (id: "individual" | "teams" | "storage", unit: string) => {
    const monthly = catalog?.prices?.[id].monthly;
    return monthly ? <p className="plan-price">{formatMoney(monthly.amount, monthly.currency)} <span>{unit}</span></p> : null;
  };
  const individual = plan("individual"), teams = plan("teams");
  return <div className="plan-grid">
    <article aria-labelledby="plan-individual">
      <h3 id="plan-individual">Individual</h3>
      {price("individual", "per month")}
      <ul>
        {individual && <li>{storage(individual.bytesPerSeat)} of storage</li>}
        <li>One drive for one person</li>
        <li>Version history, forks and S3 access keys</li>
      </ul>
    </article>
    <article aria-labelledby="plan-teams">
      <h3 id="plan-teams">Teams</h3>
      {price("teams", "per seat, per month")}
      <ul>
        {teams && <li>{storage(teams.bytesPerSeat)} of pooled storage per seat</li>}
        <li>Multiple drives per workspace</li>
        <li>Roles and email invitations</li>
      </ul>
    </article>
    <p className="plan-note">
      {catalog && <>Either plan can add storage in {storage(catalog.storageAddon.bytes)} blocks. </>}
      {catalog && catalog.trialDays > 0 && <>New accounts start with a {catalog.trialDays}-day trial. </>}
      Annual billing is available at checkout. <Link to={start}>{start === "/" ? "Open your drives" : "Create an account"}</Link>
    </p>
  </div>;
}

export function Landing() {
  const { user } = useAuth();
  const start = user ? "/" : "/login";
  const catalog = useLoad(billingCatalog);
  return <div className="landing">
    <section className="landing-hero" aria-labelledby="hero-title">
      <h1 id="hero-title">Cloud drives that open in Finder</h1>
      <p>Orbit stores your files in the cloud and mounts them on your Mac. Files download when you open them, changes upload as you save, and earlier versions are kept.</p>
      <div className="hero-actions">
        <Button asChild variant="default"><Link to={start}>{user ? "Open your drives" : "Create an account"}</Link></Button>
        <Button asChild variant="outline"><a href="#features">See what it does</a></Button>
      </div>
    </section>

    <section className="landing-section" id="features" aria-labelledby="features-title">
      <h2 id="features-title">Features</h2>
      <div className="feature-grid">
        {features.map(({ icon: Icon, title, body }) => <article key={title}><Icon aria-hidden="true" /><h3>{title}</h3><p>{body}</p></article>)}
      </div>
    </section>

    <section className="landing-section" id="plans" aria-labelledby="plans-title">
      <h2 id="plans-title">Plans</h2>
      <Plans catalog={catalog.data} start={start} />
    </section>

    <section className="landing-section" id="faq" aria-labelledby="faq-title">
      <h2 id="faq-title">Questions</h2>
      <div className="faq-list">
        {faq.map(({ q, a }) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}
      </div>
    </section>

    <footer className="landing-footer">
      <Link className="brand" to="/overview"><OrbitMark className="brand-mark" /><span>Orbit</span></Link>
      <nav aria-label="Footer">
        <a href="#features">Features</a>
        <a href="#plans">Plans</a>
        <a href="#faq">Questions</a>
        <Link to={start}>{user ? "Your drives" : "Sign in"}</Link>
      </nav>
      <span>© {new Date().getFullYear()} Orbit</span>
    </footer>
  </div>;
}
