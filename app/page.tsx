import Link from 'next/link';
import { redirect } from 'next/navigation';
import { userClient } from '@/lib/supabase/server';
import { LandingHeader } from './components/landing-header';
import { ArrowDown, ArrowRight, ArrowUpRight, BrandMark, CalendarDays, Check, Heart, MessageCircle } from './components/icons';
import './home.css';

const people = [
  { initials: 'JM', name: 'Jules Morgan', detail: 'Your old housemate', color: '#e8b5a4' },
  { initials: 'AM', name: 'Aunt Maya', detail: 'Family', color: '#8ebfbb' },
  { initials: 'SK', name: 'Sam Kim', detail: 'Work friend', color: '#e9c360' },
];

const SEND_MESSAGE_HREF =
  'mailto:?subject=Someone%20came%20to%20mind&body=Hey%2C%20I%20was%20thinking%20about%20you.%20Are%20you%20free%20to%20catch%20up%20soon%3F';

// Reads the session cookie, so this must render per request (not prerendered).
export const dynamic = 'force-dynamic';

// Signed-in users skip the landing page and go straight to the organizer app.
export default async function Home() {
  const { data } = await (await userClient()).auth.getUser();
  if (data.user) redirect('/organizer');
  return (
    <main id="top" className="home">
      <section className="hero grain">
        <div className="hero-photo" aria-hidden="true" />
        <LandingHeader />

        <div className="hero-copy container-wide">
          <p className="eyebrow rise-in">For Your People</p>
          <h1 className="serif rise-in rise-delay-1">Keep Your People Close.</h1>
          <p className="hero-description rise-in rise-delay-2">Busy Days Happen. A Little Hello Goes A Long Way.</p>
          <div className="hero-actions rise-in rise-delay-2">
            <Link className="button-primary hero-cta" href="/login">Maintain Your Relationships Better <span className="hero-cta-arrow"><ArrowRight size={17} /></span></Link>
            <a className="text-link" href="#why">A little more about it <ArrowDown size={15} /></a>
          </div>
          <p className="hero-footnote rise-in rise-delay-2"><span className="caption-line" /> One Warm Hello Can Change A Day.</p>
        </div>
        <div className="hero-scroll" aria-hidden="true">SCROLL TO FEEL IT <span /></div>
      </section>

      <section className="intro-section section-pad" id="why">
        <div className="container-wide intro-grid">
          <div className="intro-kicker"><span className="eyebrow">The quiet drift</span><span className="kicker-mark">01 / 03</span></div>
          <div className="intro-text">
            <h2 className="serif">It&rsquo;s not that you<br />stopped <em>caring.</em></h2>
            <p>It&rsquo;s Tuesday, then it&rsquo;s Thursday. A message you meant to send stays a thought. &ldquo;We should catch up&rdquo; becomes another thing you both mean&mdash;and somehow never do.</p>
            <p>Not because the relationship matters less. Just because life keeps asking for the next thing.</p>
          </div>
          <div className="drift-art" aria-label="An unfinished note reminding you to call someone" role="img">
            <div className="drift-orbit orbit-a" /><div className="drift-orbit orbit-b" />
            <div className="note-paper"><span className="note-date">SOME DAY, SOON</span><span className="note-script serif">call Jules<br />and really catch up</span><span className="note-underline" /><span className="note-note">you miss them</span></div>
            <div className="drift-dot dot-a" /><div className="drift-dot dot-b" /><div className="drift-dot dot-c" />
            <div className="flower-accent" aria-hidden="true">
              {/* eslint-disable-next-line @next/next/no-img-element -- decorative crop of a static asset */}
              <img src="/images/muop-mimosa.png" alt="" />
            </div>
          </div>
        </div>
      </section>

      <section className="reachout-section">
        <div className="reachout-backdrop" aria-hidden="true"><div className="reachout-sun" /><div className="reachout-shape shape-a" /><div className="reachout-shape shape-b" /></div>
        <div className="container-wide reachout-content">
          <span className="eyebrow">One small thing</span>
          <h2 className="serif">Then you send<br /><em>the message.</em></h2>
          <p>&ldquo;Hey. I&rsquo;ve been thinking about you. Are you free for a call this week?&rdquo;</p>
          <div className="message-visual">
            <div className="message-top"><span className="message-avatar">J</span><div><strong>Jules</strong><small>your person, always</small></div><span className="message-dots">&middot;&middot;&middot;</span></div>
            <div className="message-bubble">Okay, this made my day.<br />Thursday? I&rsquo;ll bring the stories.</div>
            <div className="message-time">DELIVERED JUST NOW <Check size={12} /></div>
          </div>
          <div className="reachout-aside"><span className="hand-arrow">&#8601;</span><span>Not a grand gesture.<br />Just a door, left open.</span></div>
        </div>
      </section>

      <section className="alive-section section-pad" id="how">
        <div className="container-wide">
          <div className="alive-heading">
            <div><span className="eyebrow">The good part</span><span className="kicker-mark">02 / 03</span></div>
            <h2 className="serif">A relationship stays alive<br />in the <em>little returns.</em></h2>
            <p>Not perfect timing. Not a packed calendar. Just remembering, reaching out, and letting the next plan take shape.</p>
          </div>
          <div className="steps">
            <article className="step-card step-one">
              <div className="step-index">01 <span>Keep them close</span></div>
              <div className="step-illustration saved-people">
                <span className="orbit-ring" />
                <span className="avatar avatar-j">J</span><span className="avatar avatar-m">M</span><span className="avatar avatar-s">S</span>
                <span className="tiny-heart"><Heart size={15} fill="currentColor" /></span>
              </div>
              <h3 className="serif">Save your people.</h3>
              <p>Friendships, family, work friends, your wider community. Make a little place for the people you want in your life.</p>
            </article>
            <article className="step-card step-two">
              <div className="step-index">02 <span>Remember what matters</span></div>
              <div className="step-illustration reminder-art">
                <div className="reminder-card"><div className="reminder-icon"><MessageCircle size={17} /></div><div><strong>Check in with Jules</strong><small>You&rsquo;ve been meaning to talk</small></div><span className="reminder-check"><Check size={13} /></span></div>
                <div className="reminder-spark" aria-hidden="true">*</div>
              </div>
              <h3 className="serif">Make the reach-out.</h3>
              <p>A gentle nudge can bring someone back to mind&mdash;before &ldquo;we should&rdquo; turns into &ldquo;it&rsquo;s been too long.&rdquo;</p>
            </article>
            <article className="step-card step-three">
              <div className="step-index">03 <span>Let plans happen</span></div>
              <div className="step-illustration calendar-art">
                <div className="calendar-sheet"><div className="calendar-month">THURSDAY, TOGETHER</div><div className="calendar-day serif">18</div><div className="calendar-footer"><span /><span /><span /></div></div>
                <div className="calendar-stamp"><CalendarDays size={20} /></div>
              </div>
              <h3 className="serif">Turn it into a plan.</h3>
              <p>From the first &ldquo;hey&rdquo; to a real time together, make it easier for good intentions to become a day you&rsquo;ll remember.</p>
            </article>
          </div>
        </div>
      </section>

      <section className="product-section">
        <div className="container-wide product-grid">
          <div className="product-copy">
            <span className="eyebrow">A little help, right on time</span>
            <h2 className="serif">Keep the people<br />you love in your<br /><em>everyday.</em></h2>
            <p>muop is a gentle place to gather the people who matter, remember to check in, and make the next catch-up real.</p>
            <Link href="/login" className="product-link">Make room for your people <ArrowRight size={17} /></Link>
            <div className="product-note"><span className="note-rule" />Built for the relationships that make a life feel like yours.</div>
          </div>
          <div className="phone-scene">
            <div className="phone-orbit" aria-hidden="true" />
            <div className="phone phone-shadow" role="img" aria-label="Illustration of a muop people list">
              <div className="phone-notch" />
              <div className="phone-head"><span>your people</span><span className="phone-add">+</span></div>
              <div className="phone-greeting serif">Good to see you.</div>
              <div className="phone-sub">A little time for your people goes a long way.</div>
              <div className="phone-label">ON YOUR MIND <span>&bull;&bull;&bull;</span></div>
              {people.map((person, index) => (
                <div className="person-row" key={person.initials}>
                  <span className="person-avatar" style={{ background: person.color }}>{person.initials}</span>
                  <span className="person-info"><strong>{person.name}</strong><small>{person.detail}</small></span>
                  <span className={`person-reminder${index === 0 ? ' reminder-today' : ''}`}>{index === 0 ? 'today' : 'soon'}</span>
                </div>
              ))}
              <div className="phone-footer"><span className="footer-active">People</span><span>Check-ins</span><span>Plans</span></div>
            </div>
            <div className="floating-note"><span className="floating-heart"><Heart size={15} fill="currentColor" /></span><span>you thought of them.<br /><b>now say hello.</b></span></div>
          </div>
        </div>
      </section>

      <section className="closing-section section-pad" id="start">
        <div className="closing-ornament" aria-hidden="true"><span>*</span><span>*</span><span>*</span></div>
        <div className="container-wide closing-inner">
          <span className="eyebrow">03 / 03 &mdash; Begin with one person</span>
          <h2 className="serif">Who came to mind<br />while you were <em>here?</em></h2>
          <p>You don&rsquo;t need the perfect words. You just need to start.</p>
          <a className="closing-button" href={SEND_MESSAGE_HREF}>Send the message <ArrowUpRight size={17} /></a>
          <span className="closing-footnote">Or <Link href="/login">save them for later with muop</Link>.</span>
        </div>
      </section>

      <footer className="site-footer">
        <div className="container-wide footer-inner">
          <BrandMark />
          <span>Make time for the people who matter.</span>
          <a href="/traction" className="back-top">Live traction <ArrowUpRight size={14} /></a>
          <a href="#top" className="back-top">Back to the beginning <ArrowUpRight size={14} /></a>
        </div>
      </footer>
    </main>
  );
}
