import Link from 'next/link';
import './home.css';

const LOGO = (
  <svg width="28" height="28" viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <path d="M14 32 L24 14 L34 32 L14 32 Z" stroke="#2E1F14" strokeWidth="2.4" strokeLinejoin="round" opacity="0.9"/>
    <circle cx="14" cy="32" r="7" fill="#F6AC0D" stroke="#2E1F14" strokeWidth="2.4"/>
    <circle cx="24" cy="14" r="7" fill="#04C1E1" stroke="#2E1F14" strokeWidth="2.4"/>
    <circle cx="34" cy="32" r="7" fill="#75E4DE" stroke="#2E1F14" strokeWidth="2.4"/>
  </svg>
);

export default function Home() {
  return (
    <main className="home">
      <section className="hero">
        <header className="topbar">
          <span className="brand">{LOGO} muop</span>
          <nav className="nav">
            <a href="#stories">Why muop</a>
            <Link href="/login" className="btn-sunshine">Get started</Link>
          </nav>
        </header>

        <h1>Make time for the people who matter.</h1>
        <p className="sub">
          Life gets busy. muop helps you nurture your friendships, family,
          professional relationships, and community, one thoughtful check-in
          and one meaningful meetup at a time.
        </p>
        <div className="cta">
          <Link href="/login" className="btn-sunshine btn-lg">Meet your muop</Link>
          <a href="#stories" className="btn-ghost btn-lg">Why muop ↓</a>
        </div>
        <p className="tagline">Make time for your people.</p>
      </section>

      <section className="section" id="stories">
        <p className="eyebrow">Sound familiar?</p>
        <h2>We&rsquo;ve all been there.</h2>
        <div className="stories">
          <div className="story-card">
            <img src="/images/muop-call.jpg" alt="A woman by a sunlit window, holding her phone and thinking of someone" />
            <div className="story-body">
              <h3>&ldquo;I keep meaning to call her.&rdquo;</h3>
              <p>Weeks slip by. <b>muop remembers for you</b> and gently nudges you when it&rsquo;s been too long.</p>
            </div>
          </div>
          <div className="story-card">
            <img src="/images/muop-raincheck.jpg" alt="One person at a cafe table set for two, the other chair empty" />
            <div className="story-body">
              <h3>&ldquo;We should get coffee soon.&rdquo;</h3>
              <p>The plan that never happens. <b>muop turns &ldquo;we should&rdquo; into a real date</b>, with one simple link.</p>
            </div>
          </div>
          <div className="story-card">
            <img src="/images/muop-plan.jpg" alt="Friends crowded around one phone, laughing together at golden hour" />
            <div className="story-body">
              <h3>&ldquo;So... where are we meeting?&rdquo;</h3>
              <p>The group chat can&rsquo;t decide. <b>Everyone votes once, and muop finds what fits the whole group.</b></p>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <p className="eyebrow">Your relationships, made easier</p>
        <h2>Every connection deserves a little attention.</h2>
        <div className="features">
          <div className="feature feature-lime">
            <h3>Personal</h3>
            <p>Stay close to friends and family, even when life gets busy.</p>
          </div>
          <div className="feature feature-aqua">
            <h3>Professional</h3>
            <p>Nurture meaningful connections and stay in touch with your network.</p>
          </div>
          <div className="feature feature-turquoise">
            <h3>Community</h3>
            <p>Bring people together and make more room for shared experiences.</p>
          </div>
        </div>
      </section>

      <section className="final-cta" id="get-started">
        <h2>A little more connection.<br />A little less &ldquo;someday.&rdquo;</h2>
        <p>muop starts with the people who matter and turns good intentions into real plans.</p>
        <Link href="/login" className="btn-sunshine btn-lg">Get started with muop</Link>
        <p className="tagline">Your people. Your time. Your way.</p>
      </section>

      <footer className="footer">
        <span className="brand">{LOGO} muop</span>
        <span>Make time for your people.</span>
        <a href="#stories">Why muop</a>
        <span>© 2026 muop</span>
      </footer>
    </main>
  );
}
