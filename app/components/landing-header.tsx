'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, BrandMark, CloseIcon, MenuIcon } from './icons';

// Landing-page header: inverse wordmark, anchor links and the sign-in CTA,
// collapsing into a toggle menu on phones.
export function LandingHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);

  return (
    <header className="site-header container-wide">
      <BrandMark inverse />
      <nav aria-label="Main navigation" className={menuOpen ? 'nav-open' : ''}>
        <a className="nav-link" href="#why" onClick={closeMenu}>Why it matters</a>
        <a className="nav-link" href="#how" onClick={closeMenu}>How muop helps</a>
        <Link className="nav-cta" href="/login" onClick={closeMenu}>Make a little room <ArrowUpRight size={15} /></Link>
      </nav>
      <button
        className="mobile-menu"
        type="button"
        aria-label={menuOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen(!menuOpen)}
      >
        {menuOpen ? <CloseIcon size={22} /> : <MenuIcon size={22} />}
      </button>
    </header>
  );
}
