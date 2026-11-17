import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUpRight, Check, ChevronDown, ChevronRight, Code2, FileCode2, FileImage, FileText, Folder, HardDrive, Laptop, Menu, Pause, Play, Plus, ShieldCheck, Sparkles, Users } from "lucide-react";
import { Button } from "./components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./components/ui/dropdown-menu";
import { useAuth } from "./context";
import { OrbitMark } from "./OrbitMark";
import "./landing.css";

const productLinks = [
  { href: "#product", label: "Cloud files", description: "A home for your next big thing", icon: HardDrive },
  { href: "#finder", label: "Desktop workflows", description: "Familiar folders. A bigger world.", icon: Laptop },
  { href: "#teams", label: "Shared workspaces", description: "Bring everyone into the same project", icon: Users },
  { href: "#ask-ai", label: "Agent workspaces", description: "Give your agents somewhere to work", icon: Sparkles },
];

export function LandingNavigation() {
  return <nav className="marketing-nav" aria-label="Product navigation">
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" className="marketing-menu-trigger" aria-label="Product navigation menu"><span className="desktop-menu-label">Product <ChevronDown size={12} /></span><Menu className="mobile-menu-icon" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent className="landing-menu" align="start" sideOffset={18}>
        {productLinks.map(({ href, label, description, icon: Icon }) => <DropdownMenuItem asChild key={href}><a href={href}><span className="menu-product-icon"><Icon size={18} /></span><span>{label}<small>{description}</small></span></a></DropdownMenuItem>)}
        <DropdownMenuItem asChild className="mobile-menu-link"><a href="#workflows">How it works</a></DropdownMenuItem>
        <DropdownMenuItem asChild className="mobile-menu-link"><a href="#pricing">Early access</a></DropdownMenuItem>
        <DropdownMenuItem asChild className="mobile-menu-link"><a href="#faq">FAQ</a></DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <a className="desktop-nav-link" href="#workflows">How it works</a>
    <a className="desktop-nav-link" href="#pricing">Early access</a>
  </nav>;
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
  return <div className="product-stage" data-reveal>
    <div className="preview-window" aria-label="Interactive Orbit product preview">
      <div className="preview-titlebar"><span className="window-dots" aria-hidden="true"><i /><i /><i /></span><span><OrbitMark /> Orbit</span><span className="preview-secure"><ShieldCheck size={12} /> Your space, connected</span></div>
      <div className="preview-layout">
        <aside className="preview-sidebar"><div className="preview-profile"><span>JD</span><div>Jamie’s workspace<small>Room for your best work</small></div></div><p className="preview-sidebar-label">YOUR DRIVES</p>
          {(Object.keys(examples) as (keyof typeof examples)[]).map((name) => <button key={name} aria-pressed={workspace === name} onClick={() => setWorkspace(name)}><HardDrive size={15} />{name}<ChevronRight size={12} /></button>)}
          <div className="preview-side-bottom"><span className="connection-dot" /> All in Orbit</div>
        </aside>
        <div className="preview-content"><div className="preview-breadcrumb">Your drives <ChevronRight size={12} /><span>{workspace}</span></div><div className="preview-heading"><div><h3>{workspace}</h3><p>A little space for something great.</p></div><span className="preview-avatar-stack" aria-label="Example team members"><i>J</i><i>A</i><i>M</i></span></div>
          <div className="preview-moodboard" aria-hidden="true"><div><img src="/images/orbit-forest.jpg" alt="" loading="lazy" width="1400" height="933" /><span>Field notes / 001</span></div><div><img src="/images/orbit-peaks.jpg" alt="" loading="lazy" width="640" height="800" /><span>A different perspective</span></div><div><img src="/images/orbit-dunes.jpg" alt="" loading="lazy" width="640" height="427" /><span>Room to explore</span></div></div>
          <table className="preview-table" aria-label={`Example files in ${workspace}`}><thead><tr><th>Name</th><th>Modified</th><th>Size</th></tr></thead><tbody>{examples[workspace].map((file) => { const Icon = fileIcons[file.kind as keyof typeof fileIcons]; return <tr key={file.name}><td><Icon size={15} />{file.name}</td><td>{file.date}</td><td>{file.size}</td></tr>; })}</tbody></table>
          <div className="preview-status"><span><span className="connection-dot" /> Connected to Orbit</span><span>Product preview · example files</span></div>
        </div>
      </div>
    </div>
    <div className="preview-caption"><span>Yours to explore.</span><span>Try switching drives <ArrowUpRight size={13} /></span></div>
  </div>;
}

const steps = [
  { id: "finder", number: "01", label: "Make yourself at home", title: "Your files. Your favorite tools.", copy: "Open cloud projects through familiar files and folders. Keep working in the apps you know, without copying your whole library onto every computer.", icon: Laptop },
  { id: "ask-ai", number: "02", label: "Let your agents in", title: "Give AI a place on the project.", copy: "Give an agent access to the files it needs. Keep its inputs and outputs in a persistent workspace, ready for you to pick up when the session ends.", icon: Sparkles },
  { id: "teams", number: "03", label: "Keep the work together", title: "Less handoff. More headway.", copy: "Connect people and compute environments to a shared workspace. Let authorized collaborators reach the project without another round of downloads and uploads.", icon: Users },
];

function WorkflowStory() {
  const [active, setActive] = useState(0);
  const story = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) setActive(Number((entry.target as HTMLElement).dataset.step));
    }, { rootMargin: "-30% 0px -35% 0px", threshold: 0 });
    story.current?.querySelectorAll("[data-step]").forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, []);
  return <section className="workflow-section" id="workflows" ref={story} aria-labelledby="workflows-title">
    <div className="landing-section workflow-heading" data-reveal><p className="eyebrow">A BETTER WAY TO WORK</p><h2 id="workflows-title">Everything in reach.<br /><span>Nothing in the way.</span></h2></div>
    <div className="landing-section workflow-grid"><div className="story-visual" data-active={active} aria-hidden="true">
      <div className="story-grid" /><div className="story-orbit story-orbit-one" /><div className="story-orbit story-orbit-two" />
      <div className="story-center"><OrbitMark /><span>One shared space.</span></div>
      {steps.map(({ icon: Icon, label }, index) => <div key={label} className={`story-node story-node-${index} ${active === index ? "is-active" : ""}`}><Icon size={20} /><span>{["Your desktop", "Your AI agents", "Your people"][index]}</span><i /></div>)}
      <div className="story-file"><FileText size={22} /><div>Next big thing.md<small>{["Open in your favorite app", "Ready for your agent", "Ready for the next person"][active]}</small></div><Check size={15} /></div>
      <div className="story-visual-caption"><span className="connection-dot" /> PEOPLE, TOOLS & POSSIBILITIES</div>
    </div><div className="story-steps">{steps.map(({ id, number, label, title, copy }, index) => <article id={id} key={id} data-step={index} className={`story-step ${active === index ? "is-active" : ""}`}><span className="step-number">{number}</span><p className="eyebrow">{label}</p><h3>{title}</h3><p>{copy}</p><a href="#product">Meet your workspace <ArrowUpRight size={15} /></a></article>)}</div></div>
  </section>;
}

const faqs = [
  ["What is Orbit?", "Orbit connects cloud storage with the people, desktop apps, and AI agents working on your projects. It gives your files a shared home that stays available beyond a single computer or compute session."],
  ["Do I need to download every file?", "The desktop experience is designed to open the files you need from remote storage, so you don’t have to copy an entire project onto every machine. Supported devices and offline behavior will be confirmed during early access."],
  ["How do AI agents use Orbit?", "Agents connect to a persistent project workspace through supported file interfaces. You can keep project inputs and generated outputs together, then return to them after a runtime ends. Integration details will be shared during early access."],
  ["Can I use it with my team?", "Shared workspaces are part of the team experience. Tell us about your collaborators, access requirements, and storage setup so we can help you evaluate the right fit."],
  ["What does it cost?", "Orbit is in early access. Final pricing, plan limits, and availability will be published before paid enrollment. You can request access for personal, developer, or team workflows below."],
  ["How can I get started?", "Choose Get early access to sign in and explore your workspace. Have a specific workflow or deployment in mind? Get in touch with our team using the contact link below."],
];

export function Landing() {
  const { user } = useAuth();
  const start = user ? "/" : "/login";
  const [motionPaused, setMotionPaused] = useState(false);
  const page = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!("IntersectionObserver" in window) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (entry.isIntersecting) { entry.target.classList.add("is-revealed"); observer.unobserve(entry.target); }
    }), { threshold: 0.08 });
    // Content remains visible without JS or observer support.
    page.current?.querySelectorAll<HTMLElement>("[data-reveal]").forEach((node) => {
      if (node.getBoundingClientRect().top > window.innerHeight) node.classList.add("reveal-ready");
      observer.observe(node);
    });
    return () => observer.disconnect();
  }, []);
  return <div className="landing" ref={page} data-motion-paused={motionPaused}>
    <section className="landing-section landing-hero" aria-labelledby="hero-title">
      <div className="hero-copy"><p className="eyebrow"><span className="connection-dot" /> A LITTLE SPACE. A LOT OF POSSIBILITY.</p><h1 id="hero-title">Your work.<br />All <span>in Orbit.</span></h1><p className="hero-description">One home for your files, your tools, and your AI agents. Less moving things around. More moving things forward.</p><div className="hero-actions"><Button asChild variant="default"><Link to={start}>Get early access <ArrowUpRight size={16} /></Link></Button><a href="#product" className="text-link">Take a look around <ArrowDown size={15} /></a></div><p className="hero-fine">Cloud files. Familiar folders. New possibilities.</p></div>
      <div className="hero-scene" aria-label="A shared Orbit workspace connecting a desktop and AI agent"><img className="hero-photo" src="/images/orbit-forest.jpg" alt="Sunlight finding its way through a green forest" width="1400" height="933" fetchPriority="high" /><div className="hero-shade" /><span className="scene-coordinate">A SPACE FOR WHAT’S NEXT / 001</span><div className="orbital-ring ring-one" /><div className="orbital-ring ring-two" /><div className="orbit-satellite"><span /></div><div className="hero-orbit-mark"><OrbitMark /></div><div className="floating-chip desktop-chip"><Laptop size={15} /> Your desktop <span className="connection-dot" /></div><div className="floating-chip agent-chip"><Sparkles size={15} /> Your AI agent <span className="connection-dot" /></div><div className="hero-file-card"><span className="hero-file-icon"><Folder size={25} /></span><div>Something great<small>One project. Everyone in the loop.</small></div><ArrowUpRight size={17} /></div><button type="button" className="scene-motion" aria-label={motionPaused ? "Resume ambient animation" : "Pause ambient animation"} aria-pressed={motionPaused} onClick={() => setMotionPaused((paused) => !paused)}>{motionPaused ? <Play size={12} /> : <Pause size={12} />}</button><div className="scene-bottom"><span>Stay connected.<br />Keep creating.</span><span className="scene-index">( O )</span></div></div>
    </section>
    <div className="connection-strip"><div><span>ONE SHARED FILESYSTEM</span><span><Laptop size={17} /> Your desktop</span><Plus size={12} /><span><Code2 size={17} /> Your tools</span><Plus size={12} /><span><Sparkles size={17} /> Your agents</span><span className="strip-end">Finally, in the same place. <ArrowDown size={14} /></span></div></div>

    <section className="landing-section product-section" id="product" aria-labelledby="product-title"><div className="section-heading-row" data-reveal><div><p className="eyebrow">MEET YOUR NEW WORKSPACE</p><h2 id="product-title">Big ideas deserve<br />a little more space.</h2></div><p>Your next project, neatly in reach. Browse cloud files, move between tools, and bring your team along. It all starts in Orbit.</p></div><ProductPreview /></section>
    <WorkflowStory />
    <section className="landing-section possibilities-section" id="features" aria-labelledby="possibilities-title"><div className="section-heading-row" data-reveal><div><p className="eyebrow">BUILT AROUND YOUR FLOW</p><h2 id="possibilities-title">A shared space.<br />An open world.</h2></div><p>From the first sketch to the next agent run, keep the work together and the possibilities open.</p></div><div className="possibility-grid"><article className="creative-card" data-reveal><div className="creative-visual" aria-hidden="true"><img src="/images/orbit-dunes.jpg" alt="" width="640" height="427" loading="lazy" /><div className="creative-label">EXPLORATIONS<br /><span>Vol. 01 — Something new</span></div><div className="creative-file"><FileImage size={16} /> A fresh perspective.png <Check size={13} /></div></div><div className="possibility-copy"><span>FOR THE MAKERS</span><h3>Stay in your creative flow.</h3><p>Keep the brief, the assets, and the next version together. Spend your energy on the work you love.</p><a href="#product">Find your space <ArrowUpRight size={15} /></a></div></article><article className="builder-card" data-reveal><div className="builder-visual" aria-hidden="true"><div className="terminal-bar"><span className="window-dots"><i /><i /><i /></span><span>agent-workspace</span></div><div className="terminal-code"><span className="terminal-comment"># A place to pick up where you left off</span><br /><span className="terminal-green">workspace/</span><br />&nbsp; ├── brief.md<br />&nbsp; ├── source/<br />&nbsp; └── output/<br /><br /><span className="terminal-green">✓</span> Session ends. Work stays.</div><div className="terminal-note"><Sparkles size={14} /> Your next run starts with context.</div></div><div className="possibility-copy"><span>FOR THE BUILDERS</span><h3>New session. Same momentum.</h3><p>Give agents a persistent home for project files. Keep useful work beyond the life of a runtime.</p><a href="https://orbitfs.io/docs">Explore the docs <ArrowUpRight size={15} /></a></div></article></div></section>

    <section className="access-section" id="pricing" aria-labelledby="access-title"><div className="landing-section"><div className="section-heading-row" data-reveal><div><p className="eyebrow">COME BUILD WITH US</p><h2 id="access-title">Your next chapter<br />starts here.</h2></div><p>We’re opening Orbit to people with work to do and ideas to explore. Find your way in.</p></div><div className="access-grid">{[
      { name: "Personal", number: "01", title: "A space of your own.", copy: "For your projects, side quests, and everything you’re making next.", items: ["Cloud files in familiar folders", "Your projects across computers", "A home for your creative work"] },
      { name: "Developers", number: "02", title: "Room for your agents.", copy: "For builders who want their work to outlast a single compute session.", items: ["Persistent agent workspaces", "Project inputs and outputs together", "Familiar file interfaces"] },
      { name: "Teams", number: "03", title: "Everyone in the loop.", copy: "For people bringing collaborators, tools, and workflows together.", items: ["Shared project workspaces", "Access for people and agents", "Deployment planning together"] },
    ].map((plan) => <article key={plan.name} className="access-card" aria-labelledby={`${plan.name.toLowerCase()}-plan-title`} data-reveal><div className="access-card-top"><h3 id={`${plan.name.toLowerCase()}-plan-title`}>{plan.name}</h3><span>{plan.number}</span></div><h4>{plan.title}</h4><p>{plan.copy}</p><ul>{plan.items.map((item) => <li key={item}><Check size={14} />{item}</li>)}</ul><Button asChild variant={plan.name === "Developers" ? "default" : "outline"}>{plan.name === "Teams" ? <a href="https://orbitfs.io/contact">Let’s talk <ArrowUpRight size={15} /></a> : <Link to={start}>Get early access <ArrowUpRight size={15} /></Link>}</Button></article>)}</div><p className="plans-note">Orbit is in early access. Final features, limits, availability, and pricing will be shared before paid enrollment.</p></div></section>
    <section className="landing-section landing-faq" id="faq" aria-labelledby="faq-title"><div data-reveal><p className="eyebrow">A FEW THINGS TO KNOW</p><h2 id="faq-title">Good questions.<br />Straight answers.</h2><p>Something else on your mind?</p><a className="text-link" href="https://orbitfs.io/contact">Talk to us <ArrowUpRight size={15} /></a></div><div className="faq-list">{faqs.map(([question, answer]) => <details key={question}><summary>{question}<Plus size={17} /></summary><p>{answer}</p></details>)}</div></section>
    <section className="landing-cta" aria-labelledby="cta-title"><div className="cta-ring cta-ring-one" /><div className="cta-ring cta-ring-two" /><div className="cta-content" data-reveal><OrbitMark /><p className="eyebrow">LESS FRICTION. MORE POSSIBILITY.</p><h2 id="cta-title">Good things<br />are coming <em>into Orbit.</em></h2><p>Make a little space for what’s next.</p><Button asChild variant="default"><Link to={start}>Get early access <ArrowUpRight size={16} /></Link></Button></div></section>
    <footer className="landing-section landing-footer"><div className="footer-top"><div><Link className="brand" to="/overview"><OrbitMark className="brand-mark" /><span>Orbit</span></Link><p>Your work. All in Orbit.</p></div><nav aria-label="Footer product navigation"><a href="#product">Product</a><a href="#workflows">How it works</a><a href="#pricing">Early access</a></nav><nav aria-label="Footer resources"><a href="https://orbitfs.io/docs">Documentation</a><a href="https://orbitfs.io/contact">Contact</a><Link to={start}>{user ? "Your workspace" : "Sign in"}</Link></nav></div><div className="footer-bottom"><span>© {new Date().getFullYear()} Orbit</span><span>A little space for something great.</span><a href="#hero-title">Back to top <ArrowUpRight size={13} /></a></div></footer>
  </div>;
}
