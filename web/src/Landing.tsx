import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Check, ChevronDown, ChevronRight, Globe, Menu, FileCode2, FileImage, FileText, Folder, HardDrive, MoreHorizontal, Plus, Search, ShieldCheck, Sparkles, Users } from "lucide-react";
import { Button } from "./components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./components/ui/dropdown-menu";
import { useAuth } from "./context";
import { OrbitMark } from "./OrbitMark";
import "./landing.css";

const productLinks = [
  { href: "#product", label: "Cloud files", description: "Cloud files feel close", icon: HardDrive },
  { href: "#finder", label: "Desktop workflows", description: "Built for the tools you use", icon: Folder },
  { href: "#teams", label: "Shared workspaces", description: "One workspace across environments", icon: Users },
  { href: "#ask-ai", label: "Agent workspaces", description: "Let your AI agents participate", icon: Sparkles },
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
        <DropdownMenuItem asChild className="mobile-menu-link"><a href="#workflows">Workflows</a></DropdownMenuItem>
        <DropdownMenuItem asChild className="mobile-menu-link"><a href="#pricing">Plans</a></DropdownMenuItem>
        <DropdownMenuItem asChild className="mobile-menu-link"><a href="#faq">FAQ</a></DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <a className="desktop-nav-link" href="#features">Features</a>
    <a className="desktop-nav-link" href="#workflows">Workflows</a>
    <a className="desktop-nav-link" href="#pricing">Plans</a>
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
    <div className="preview-window" aria-label="Interactive OrbitFS product preview">
      <div className="preview-titlebar"><span className="window-dots" aria-hidden="true"><i /><i /><i /></span><span>OrbitFS</span><span className="preview-secure"><ShieldCheck size={13} /> Your space, connected</span></div>
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
          <div className="preview-status"><span><span className="connection-dot" /> OrbitFS product preview</span><span>Product preview · example files</span></div>
        </div>
      </div>
    </div>
    <div className="preview-caption"><span>Same files. Familiar surroundings.</span><span>Try switching drives above <ArrowUpRight size={13} /></span></div>
  </div>;
}

export function Landing() {
  const { user } = useAuth();
  const start = user ? "/" : "/login";
  return <div className="landing">
    <section className="landing-hero" aria-labelledby="hero-title">
      <h1 id="hero-title">One filesystem for people<br className="desktop-break" /> and AI agents</h1>
      <p>Open cloud files on your computer and give agents the same persistent workspace. Move between machines without copying entire projects.</p>
      <div className="hero-actions"><Button asChild variant="default"><Link to={start}>Get Early Access</Link></Button></div>
      <p className="hero-fine">Desktop and agents</p>
      <div className="hero-file-field" aria-hidden="true"><div><FileText /><span>Launch brief.md</span></div><div><Folder /><span>Studio projects</span></div><div><FileImage /><span>Something great.png</span></div><div><FileCode2 /><span>Your next idea.tsx</span></div></div>
    </section>

    <section className="landing-section product-section" aria-labelledby="product-title">
      <div className="section-heading-copy"><h2 id="product-title">One file. Two places. No handoff.</h2><p>Watch an agent update a file, then open it on your desktop. Same files, no manual transfers.</p></div>
      <ProductPreview />
    </section>

    <section className="landing-section" id="features" aria-labelledby="features-title">
      <div className="section-heading-copy"><h2 id="features-title">Your work moves. Your files stay put.</h2><p>OrbitFS connects desktop applications and AI agents to remote storage. Access your projects without repeatedly moving files between tools, machines, and sessions.</p></div>
      <div className="landing-features">
        <FeatureCard id="finder" title="Cloud files feel close" description="Browse cloud projects through a familiar local filesystem interface. Open the files you need while the rest of your library remains remotely stored.">
          <div className="mini-finder"><div className="mini-window-bar"><span className="window-dots"><i /><i /><i /></span><span>Studio</span></div><div className="mini-finder-path"><OrbitMark /> OrbitFS <ChevronRight size={12} /> Studio</div><div className="mini-folder-row"><span><Folder />Projects</span><span><Folder />Assets</span><span><FileImage />Cover.png</span></div><div className="mini-window-status"><Check size={11} /> Connected to OrbitFS</div></div>
        </FeatureCard>
        <FeatureCard id="teams" title="One workspace across environments" description="Access shared files from your desktop and compute environments. Updates become available to other authorized desktop and agent connections.">
          <div className="sharing-demo"><div className="sharing-file"><Folder size={20} /><span>Studio workspace<small>Shared with your team</small></span><Users size={16} /></div><div className="sharing-member"><span className="member-avatar">A</span><span>Alex<small>alex@example.com</small></span><span>Owner <ChevronDown size={10} /></span></div><div className="sharing-member"><span className="member-avatar">J</span><span>Jamie<small>jamie@example.com</small></span><span>Can edit <ChevronDown size={10} /></span></div><div className="sharing-invite"><Plus size={12} /> Invite a teammate</div></div>
        </FeatureCard>
        <FeatureCard id="tools" title="Built for the tools you use" description="Work in your usual desktop apps and developer tools. OrbitFS uses files, folders, and paths your workflows already understand.">
          <div className="mini-finder"><div className="mini-window-bar"><span className="window-dots"><i /><i /><i /></span><span>Project files</span></div><div className="mini-finder-path"><OrbitMark /> OrbitFS <ChevronRight size={12} /> Projects</div><div className="mini-folder-row"><span><FileCode2 />Code</span><span><FileText />Documents</span><span><FileImage />Assets</span></div><div className="mini-window-status"><Folder size={11} /> Files, folders, and paths</div></div>
        </FeatureCard>
      </div>
      <div className="capability-grid feature-details">
        <article id="ask-ai"><Sparkles /><h3>Let your AI agents participate</h3><p>Give agents space to read inputs, write outputs, and share finished work. Review their results from your computer, not another disconnected dashboard or download folder.</p></article>
        <article><HardDrive /><h3>Keep working after sessions end</h3><p>Short lived compute should not mean short lived files. Keep project artifacts independent of individual agent runtimes so future sessions can continue.</p></article>
      </div>
      <div className="landing-resource-links"><a href="https://orbitfs.io/docs">Building with OrbitFS? Explore the docs.</a><a href="https://orbitfs.io/contact">Deploying for a team? Talk to us.</a></div>
    </section>

    <section className="landing-section landing-context" aria-labelledby="context-title"><div className="section-heading-copy"><h2 id="context-title">Find files. Keep context.</h2><p>Use consistent paths across machines and agents. Give workflows access to the project files they need without uploading the materials into each session.</p></div></section>

    <section className="landing-section infrastructure-section" id="workflows" aria-labelledby="workflows-title">
      <div className="infrastructure-intro"><h2 id="workflows-title">Built for people and processes</h2><p>One filesystem for your devices, creative tools, teams, and AI workers.</p></div>
      <div className="capability-grid">
        <article><HardDrive /><h3>Everyday computing</h3><p>Open and edit large projects without filling your computer with unnecessary local copies.</p><a className="workflow-link" href="#finder">Explore desktop workflows</a></article>
        <article><FileCode2 /><h3>AI development</h3><p>Keep agent inputs and outputs accessible between separate compute sessions.</p><a className="workflow-link" href="#ask-ai">Explore agent workspaces</a></article>
        <article><FileImage /><h3>Creative production</h3><p>Move between editing tools while your assets stay together.</p><a className="workflow-link" href="#product">Explore creative workflows</a></article>
        <article><Users /><h3>Team operations</h3><p>Review changes made by colleagues, scripts, and your automated assistants.</p><a className="workflow-link" href="#teams">Explore team workflows</a></article>
      </div>
    </section>

    <section className="landing-section infrastructure-section landing-contact" id="contact" aria-labelledby="contact-title">
      <div className="infrastructure-intro"><h2 id="contact-title">Control the workspace, not every transfer.</h2><p>Choose how people, applications, and agents connect to storage. Build workflows around permissions, collaboration, and infrastructure choices.</p><Button asChild><a href="https://orbitfs.io/contact">Contact us</a></Button></div>
      <ul className="workspace-options"><li><Users />Team access</li><li><HardDrive />Storage options</li><li><Globe />Activity visibility</li><li><ShieldCheck />Deployment planning</li></ul>
    </section>

    <section className="landing-section" id="pricing" aria-labelledby="pricing-title">
      <div className="section-heading-copy"><h2 id="pricing-title">Plans that grow with your workflow</h2><p>Choose a desktop workspace, an agent workspace, or a team plan. Pricing will be announced at launch.</p><p>Personal · Developers · Teams</p></div>
      <div className="landing-features">
        <article className="landing-feature landing-plan" aria-labelledby="personal-plan-title">
          <div className="feature-copy">
            <h3 id="personal-plan-title">Personal</h3><p>For individuals wanting files across computers.</p>
            <p className="plan-availability">Coming soon</p>
            <Button asChild variant="default"><Link to={start}>Join early access</Link></Button>
            <ul>
              <li><Check size={14} aria-hidden="true" />A familiar mounted workspace</li>
              <li><Check size={14} aria-hidden="true" />Remote files without full library downloads</li>
              <li><Check size={14} aria-hidden="true" />Desktop first experience</li>
              <li><Check size={14} aria-hidden="true" />Open existing project folders</li>
              <li><Check size={14} aria-hidden="true" />See files in the apps you use</li>
              <li><Check size={14} aria-hidden="true" />Simple onboarding for users</li>
              <li><Check size={14} aria-hidden="true" />Designed for independent projects</li>
            </ul>
            <span className="plan-status">Early access</span>
          </div>
        </article>
        <article className="landing-feature landing-plan" aria-labelledby="developers-plan-title">
          <div className="feature-copy">
            <h3 id="developers-plan-title">Developers</h3><p>For builders creating persistent workspaces for AI agents.</p>
            <p className="plan-availability">Coming soon</p>
            <Button asChild variant="default"><Link to={start}>Request developer access</Link></Button>
            <ul>
              <li><Check size={14} aria-hidden="true" />Shared filesystem concepts</li>
              <li><Check size={14} aria-hidden="true" />Read and write files through supported interfaces</li>
              <li><Check size={14} aria-hidden="true" />Agent project inputs and outputs</li>
              <li><Check size={14} aria-hidden="true" />Storage independent of short lived runtimes</li>
              <li><Check size={14} aria-hidden="true" />Documentation and examples</li>
              <li><Check size={14} aria-hidden="true" />Workspace based organization</li>
              <li><Check size={14} aria-hidden="true" />Feedback channel for early adopters</li>
            </ul>
            <span className="plan-status">Early access</span>
          </div>
        </article>
        <article className="landing-feature landing-plan" aria-labelledby="teams-plan-title">
          <div className="feature-copy">
            <h3 id="teams-plan-title">Teams</h3><p>For organizations connecting people, processes, and applications.</p>
            <p className="plan-availability">Contact us</p>
            <p>Requirements discussed together</p>
            <ul>
              <li><Check size={14} aria-hidden="true" />Workspaces for collaborative projects</li>
              <li><Check size={14} aria-hidden="true" />Plan access for team members</li>
              <li><Check size={14} aria-hidden="true" />Review integration and deployment needs</li>
              <li><Check size={14} aria-hidden="true" />Choose storage architecture</li>
              <li><Check size={14} aria-hidden="true" />Discuss reliability and performance requirements</li>
              <li><Check size={14} aria-hidden="true" />Evaluate agent and desktop workflows</li>
              <li><Check size={14} aria-hidden="true" />Plan onboarding with our team</li>
            </ul>
            <Button asChild><a href="https://orbitfs.io/contact">Contact sales</a></Button>
          </div>
        </article>
      </div>
      <p className="plans-note">Plans are proposals. Final features, limits, availability, and pricing will be published before paid enrollment.</p>
    </section>

    <section className="landing-section landing-faq" id="faq" aria-labelledby="faq-title"><div><h2 id="faq-title">Frequently asked questions</h2><p>Deciding where OrbitFS fits? Tell us what you are building. We read messages.</p></div><div className="faq-list">
      <details><summary>What is OrbitFS?<Plus size={16} /></summary><p>OrbitFS is a filesystem experience designed to connect cloud storage with computers and AI agents doing the work. The goal is straightforward: access your files through familiar paths, let automated workflows use a shared project workspace, and keep work available after a compute session ends. Supported devices, integrations, and performance will be confirmed at launch.</p></details>
      <h3 className="faq-question">Who should use OrbitFS?</h3>
      <h3 className="faq-question">How is this different from cloud sync tools?</h3>
      <h3 className="faq-question">Does OrbitFS download every file?</h3>
      <h3 className="faq-question">Will it work with my existing desktop applications?</h3>
      <h3 className="faq-question">Can my AI agents read and write files?</h3>
      <h3 className="faq-question">What happens when an agent runtime stops?</h3>
      <h3 className="faq-question">Can teammates access the same workspace?</h3>
      <h3 className="faq-question">Do I need an internet connection?</h3>
      <h3 className="faq-question">Which platforms will be supported first?</h3>
      <h3 className="faq-question">Will there be an SDK or API?</h3>
      <h3 className="faq-question">How will access permissions work?</h3>
      <h3 className="faq-question">Can I connect existing cloud storage?</h3>
      <h3 className="faq-question">When can I try OrbitFS?</h3>
    </div></section>

    <section className="landing-cta"><OrbitMark /><h2>Give your work room to move.</h2><p>Bring desktop apps and agents into one filesystem. Join the list to try OrbitFS.</p><div className="hero-actions"><Button asChild variant="default"><Link to={start}>Get Early Access</Link></Button></div></section>
    <footer className="landing-footer"><div className="footer-top"><div><Link className="brand" to="/overview"><OrbitMark className="brand-mark" /><span>OrbitFS</span></Link><p>One filesystem for people and AI agents.</p></div><nav aria-label="Footer product navigation"><h3>Product</h3><a href="#product">Cloud files</a><a href="#finder">Desktop workflows</a><a href="#teams">Shared workspaces</a><a href="#ask-ai">Agent workspaces</a></nav><nav aria-label="Footer resources"><h3>Explore</h3><a href="#features">Features</a><a href="#workflows">Workflows</a><a href="#pricing">Plans</a><a href="#faq">Frequently asked questions</a><Link to={start}>{user ? "Your workspace" : "Sign in"}</Link></nav></div><div className="footer-bottom"><span>© {new Date().getFullYear()} OrbitFS</span><a href="#hero-title">Back to top <ArrowUpRight size={13} /></a></div></footer>
  </div>;
}
