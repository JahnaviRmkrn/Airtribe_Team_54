// The shipped Sheets client uses Link only for this one internal back link.
// This fixture does not claim Next Link/navigation behavior.
export default function FixtureLink({ href, children }) {
  if (href !== '/organizer/#/contacts') throw new Error('Unexpected fixture link');
  return <a href={href}>{children}</a>;
}
