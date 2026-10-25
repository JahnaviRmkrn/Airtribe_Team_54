'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, BrandMark, CloseIcon, MenuIcon } from './icons';

// Keep the login entry outside the collapsible navigation so it stays visible
// on phones as well as desktop.
export function LandingHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);

  return (
    <header className="site-header container-wide">
      <BrandMark inverse />
      <nav id="landing-navigation" aria-label="Main navigation" className={menuOpen ? 'nav-open' : ''}>
        <a className="nav-link" href="#why" onClick={closeMenu}>Why it matters</a>
        <a className="nav-link" href="#how" onClick={closeMenu}>How muop helps</a>
      </nav>
      <div className="header-actions">
        <Link className="nav-cta" href="/login" onClick={closeMenu}>Log in <ArrowUpRight size={15} /></Link>
        <button
          className="mobile-menu"
          type="button"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={menuOpen}
          aria-controls="landing-navigation"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          {menuOpen ? <CloseIcon size={22} /> : <MenuIcon size={22} />}
        </button>
      </div>
    </header>
  );
}
