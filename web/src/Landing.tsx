import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowRight, ArrowUpRight, Check, ChevronDown, ChevronRight, Globe, History, KeyRound, Menu, FileCode2, FileImage, FileText, Folder, HardDrive, MoreHorizontal, Plus, Search, ShieldCheck, Sparkles, Users } from "lucide-react";
import { Button } from "./components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./components/ui/dropdown-menu";
import { useAuth } from "./context";
import { OrbitMark } from "./OrbitMark";
import "./landing.css";

const productLinks = [
  { href: "#product", label: "Cloud drives", description: "Your files, in familiar surroundings", icon: HardDrive },
  { href: "#finder", label: "Orbit for Mac", description: "Bring your cloud drive into Finder", icon: Folder },
  { href: "#teams", label: "Shared workspaces", description: "A home for your team’s files", icon: Users },
  { href: "#ask-ai", label: "Ask AI", description: "Work through ideas with your files", icon: Sparkles },
];

export function LandingNavigation() {
  return <nav className="marketing-nav" aria-label="Product navigation">
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="marketing-menu-trigger" aria-label="Product navigation menu"><span className="desktop-menu-label">Product <ChevronDown size={12} /></span><Menu className="mobile-menu-icon" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="landing-menu" align="start" sideOffset={18}>
        {productLinks.map(({ href, label, description, icon: Icon }) => <DropdownMenuItem asChild key={href}><a href={href}><span className="menu-product-icon"><Icon size={18} /></span><span>{label}<small>{description}</small></span></a></DropdownMenuItem>)}
        <DropdownMenuItem asChild className="mobile-menu-link"><a href="#features">Features</a></DropdownMenuItem>
        <DropdownMenuItem asChild className="mobile-menu-link"><a href="#how-it-works">How it works</a></DropdownMenuItem>
        <DropdownMenuItem asChild className="mobile-menu-link"><a href="#faq">FAQ</a></DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <a className="desktop-nav-link" href="#features">Features</a>
    <a className="desktop-nav-link" href="#how-it-works">How it works</a>
    <a className="desktop-nav-link" href="#faq">FAQ</a>
  </nav>;
}

function FeatureCard({ id, title, description, children }: { id: string; title: string; description: string; children: ReactNode }) {
  return <article className="landing-feature" id={id}><div className="feature-visual" aria-hidden="true">{children}</div><div className="feature-copy"><h3>{title}</h3><p>{description}</p></div></article>;
}

const examples = {
  Studio: [
    { name: "Brand & identity", size: "12 items", kind: "folder", date: "Today" },
    { name: "Campaigns", size: "8 items", kind: "folder", date: "Today" },
    { name: "Website explorations.fig", size: "24.6 MB", kind: "image", date: "Today" },
    { name: "Launch brief.md", size: "8 KB", kind: "text", date: "Yesterday" },
    { name: "Autumn collection.png", size: "18.2 MB", kind: "image", date: "Yesterday" },
  ],
  Development: [
    { name: "Projects", size: "6 items", kind: "folder", date: "Today" },
    { name: "Datasets", size: "14 items", kind: "folder", date: "Today" },
    { name: "architecture.md", size: "12 KB", kind: "text", date: "Today" },
    { name: "config.json", size: "2 KB", kind: "code", date: "Yesterday" },
    { name: "release-notes.md", size: "6 KB", kind: "text", date: "Yesterday" },
  ],
  Personal: [
    { name: "Photos", size: "42 items", kind: "folder", date: "Today" },
    { name: "Side projects", size: "9 items", kind: "folder", date: "Today" },
    { name: "Travel plans.md", size: "4 KB", kind: "text", date: "Today" },
    { name: "Weekend in the hills.png", size: "12.8 MB", kind: "image", date: "Yesterday" },
    { name: "Reading list.md", size: "3 KB", kind: "text", date: "Yesterday" },
  ],
};
const fileIcons = { folder: Folder, image: FileImage, text: FileText, code: FileCode2 };

function ProductPreview() {
  const [workspace, setWorkspace] = useState<keyof typeof examples>("Studio");
  return <div className="product-stage" id="product">
    <div className="preview-window" aria-label="Interactive Orbit product preview">
      <div className="preview-titlebar"><span className="window-dots" aria-hidden="true"><i /><i /><i /></span><span>orbit</span><span className="preview-secure"><ShieldCheck size={13} /> Your space, connected</span></div>
      <div className="preview-layout">
        <aside className="preview-sidebar" aria-label="Example workspaces">
          <div className="preview-profile"><span>A</span><div>Alex’s workspace<small>Example account</small></div></div>
          <p className="preview-sidebar-label">Your drives</p>
          {(Object.keys(examples) as (keyof typeof examples)[]).map(name => <button key={name} type="button" aria-pressed={name === workspace} onClick={() => setWorkspace(name)}><HardDrive size={16} />{name}<ChevronRight size={13} /></button>)}
          <div className="preview-side-bottom"><span><Users size={15} /> Shared with your team</span><span><Check size={14} /> Everything in its place</span></div>
        </aside>
        <div className="preview-content" aria-live="polite">
          <div className="preview-breadcrumb">Your drives <ChevronRight size={12} /><span>{workspace}</span></div>
          <div className="preview-heading"><div><span className="preview-drive-icon"><HardDrive size={24} /></span><div><h2>{workspace}</h2><p>Your files. Your team. One shared drive.</p></div></div><span className="preview-avatar-stack" aria-label="Three example members"><i>A</i><i>J</i><i>M</i></span></div>
          <div className="preview-toolbar"><span>All files <span className="preview-count">5</span></span><span aria-hidden="true"><Search size={15} /><Plus size={15} /><MoreHorizontal size={17} /></span></div>
          <table className="preview-files"><caption className="sr-only">Example files in {workspace}</caption><thead><tr><th>Name</th><th>Modified</th><th>Size</th></tr></thead><tbody>{examples[workspace].map(file => {
            const FileIcon = fileIcons[file.kind as keyof typeof fileIcons];
            return <tr key={file.name}><td><span className={`preview-file-icon ${file.kind}`}><FileIcon size={19} /></span>{file.name}</td><td>{file.date}</td><td>{file.size}</td></tr>;
          })}</tbody></table>
          <div className="preview-status"><span><span className="connection-dot" /> Orbit product preview</span><span>Product preview · example files</span></div>
        </div>
      </div>
    </div>
    <div className="preview-caption"><span>Same files. Familiar surroundings.</span><span>Try switching drives above <ArrowUpRight size={13} /></span></div>
  </div>;
}

export function Landing() {
  const { user } = useAuth();
  const start = user ? "/" : "/login";
  const startLabel = user ? "Open your workspace" : "Get started with Orbit";
  return <div className="landing">
    <section className="landing-hero" aria-labelledby="hero-title">
      <a className="hero-note" href="#product"><span>Meet Orbit</span> A little more space for your work <ArrowRight size={14} /></a>
      <h1 id="hero-title">All your files.<br /> Within reach.</h1>
      <p>A cloud drive that feels local. Bring your files, your apps,<br className="desktop-break" /> and your team into the same orbit.</p>
      <div className="hero-actions"><Button asChild variant="default"><Link to={start}>{startLabel}</Link></Button><Button asChild variant="ghost"><a href="#product">Explore the product <ArrowDown size={14} /></a></Button></div>
      <p className="hero-fine">7-day trial. No credit card required.</p>
      <div className="hero-file-field" aria-hidden="true"><div><FileText /><span>Launch brief.md</span></div><div><Folder /><span>Studio projects</span></div><div><FileImage /><span>Something great.png</span></div><div><FileCode2 /><span>Your next idea.tsx</span></div></div>
    </section>

    <div className="landing-connections" aria-label="Ways to work with Orbit"><p>Built for the tools you already work in.</p><div><span><HardDrive />Finder</span><span><Globe />Browser</span><span><Users />Your team</span><span><Sparkles />Ask AI</span></div></div>

    <section className="landing-section product-section" aria-label="Explore Orbit">
      <div className="section-heading-copy"><h2>Your files, right where you need them.</h2><p>One familiar home for everything you’re working on.<br /> Switch drives to take a look around.</p></div>
      <ProductPreview />
    </section>

    <section className="landing-section" id="features" aria-labelledby="features-title">
      <div className="section-heading-copy"><h2 id="features-title">Keep your tools.<br /> Give your files a better home.</h2><p>From your first idea to the shared folder.<br /> Everything you need to keep work moving.</p></div>
      <div className="landing-features">
        <FeatureCard id="finder" title="A cloud drive. A local feeling." description="Mount your drive in Finder and open files in the Mac apps you already use. Your workflow comes with you.">
          <div className="mini-finder"><div className="mini-window-bar"><span className="window-dots"><i /><i /><i /></span><span>Studio</span></div><div className="mini-finder-path"><OrbitMark /> Orbit <ChevronRight size={12} /> Studio</div><div className="mini-folder-row"><span><Folder />Projects</span><span><Folder />Assets</span><span><FileImage />Cover.png</span></div><div className="mini-window-status"><Check size={11} /> Connected to Orbit</div></div>
        </FeatureCard>
        <FeatureCard id="teams" title="Good work happens together." description="Invite your team into a shared workspace. Choose who can read, write, and manage each drive.">
          <div className="sharing-demo"><div className="sharing-file"><Folder size={20} /><span>Studio workspace<small>Shared with your team</small></span><Users size={16} /></div><div className="sharing-member"><span className="member-avatar">A</span><span>Alex<small>alex@example.com</small></span><span>Owner <ChevronDown size={10} /></span></div><div className="sharing-member"><span className="member-avatar">J</span><span>Jamie<small>jamie@example.com</small></span><span>Can edit <ChevronDown size={10} /></span></div><div className="sharing-invite"><Plus size={12} /> Invite a teammate</div></div>
        </FeatureCard>
        <FeatureCard id="ask-ai" title="A thought partner for your files." description="Attach text files to Ask AI. Explore the details, work through an idea, or find a useful starting point.">
          <div className="ai-demo"><div className="mini-question"><FileText size={13} /> Launch brief.md</div><div className="mini-prompt">What should we focus on for launch?</div><div className="mini-answer"><span><Sparkles size={15} /></span><div>Let’s start with the big picture.<i /><i /><i /></div></div><div className="mini-ai-input">Ask a follow-up… <ArrowUpRight size={13} /></div></div>
        </FeatureCard>
      </div>
    </section>

    <section className="landing-section infrastructure-section" aria-label="More ways to work">
      <div className="infrastructure-intro"><h2>Less friction.<br /> More room to work.</h2><p>Behind every drive are the everyday details that help your files stay organized and in your control.</p></div>
      <div className="capability-grid">
        <article><Globe /><h3>Open in your browser</h3><p>Browse, upload, and download your files from a modern browser.</p></article>
        <article><History /><h3>Keep a little history</h3><p>Browse previous file versions and download the one you need.</p></article>
        <article><KeyRound /><h3>Connect your own tools</h3><p>Create scoped access keys for S3-compatible tools and workflows.</p></article>
        <article><ShieldCheck /><h3>Share on your terms</h3><p>Give each person the access they need with drive-level permissions.</p></article>
      </div>
    </section>

    <section className="landing-section landing-steps" id="how-it-works" aria-labelledby="steps-title"><div><h2 id="steps-title">Your next workspace.<br /> A few steps away.</h2><p>A familiar way to work, with a little more room.</p><Button asChild variant="default"><Link to={start}>{user ? "Open workspace" : "Create your account"}</Link></Button></div><ol><li><span>1</span><div><h3>Start with your email.</h3><p>Sign in with a verification code or your Google account. Your personal workspace is prepared for you.</p></div></li><li><span>2</span><div><h3>Give your work a home.</h3><p>Add your files and organize your projects. Invite collaborators with a Teams workspace.</p></div></li><li><span>3</span><div><h3>Keep going in Finder.</h3><p>Connect the Mac app to mount your drive. Your files are ready in familiar surroundings.</p></div></li></ol></section>

    <section className="landing-section landing-faq" id="faq" aria-labelledby="faq-title"><div><h2 id="faq-title">A few things<br /> you might be wondering.</h2><p>Get to know your new space.</p></div><div className="faq-list">
      <details><summary>What is Orbit?<Plus size={16} /></summary><p>Orbit is a cloud drive for your files and your team. You can manage files in a web browser and mount your drives in Finder with the Mac app.</p></details>
      <details><summary>Can I try it before choosing a plan?<Plus size={16} /></summary><p>Yes. Your personal workspace includes a seven-day trial with no credit card required. The trial begins once your drive is ready. Available plans and current prices are shown in Billing after sign-in.</p></details>
      <details><summary>Can I work with my team?<Plus size={16} /></summary><p>Teams workspaces support shared drives, invitations, and access controls. Workspace owners and administrators manage the team and its subscription.</p></details>
      <details><summary>Which devices can I use?<Plus size={16} /></summary><p>Use the web app from a modern browser, or connect the native Mac app to work with drives in Finder. Mounting and streaming files requires a connection to Orbit.</p></details>
      <details><summary>What can Ask AI access?<Plus size={16} /></summary><p>Ask AI works with your conversation and the text files you explicitly attach. It cannot browse other files or change your drive. Check generated answers before relying on them.</p></details>
    </div></section>

    <section className="landing-cta"><OrbitMark /><h2>Make room for<br /> your best work.</h2><p>Your files. Your tools. Your Orbit.</p><div className="hero-actions"><Button asChild variant="default"><Link to={start}>{startLabel}</Link></Button><Button asChild variant="ghost"><a href="#product">Take another look <ArrowRight size={14} /></a></Button></div></section>
    <footer className="landing-footer"><div className="footer-top"><div><Link className="brand" to="/overview"><OrbitMark className="brand-mark" /><span>orbit</span></Link><p>Your files, in their element.</p></div><nav aria-label="Footer product navigation"><h3>Product</h3><a href="#product">Cloud drives</a><a href="#finder">Orbit for Mac</a><a href="#teams">Shared workspaces</a><a href="#ask-ai">Ask AI</a></nav><nav aria-label="Footer resources"><h3>Explore</h3><a href="#features">Features</a><a href="#how-it-works">How it works</a><a href="#faq">Common questions</a><Link to={start}>{user ? "Your workspace" : "Sign in"}</Link></nav></div><div className="footer-bottom"><span>© {new Date().getFullYear()} Orbit</span><a href="#hero-title">Back to top <ArrowUpRight size={13} /></a></div></footer>
  </div>;
}
