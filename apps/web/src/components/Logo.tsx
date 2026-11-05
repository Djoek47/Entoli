export function Logo({ href = '/' }: { href?: string }) {
  return (
    <a className="logo" href={href} aria-label="Entoli home">
      <span className="mk" aria-hidden>{'>'}<i /><i /><i /></span>
      <span>Entol<span className="dot">ı</span></span>
    </a>
  );
}

export function Footer() {
  return (
    <footer className="foot"><div className="wrap">
      <span>Entoli · the AIUIC for developers</span>
      <a href="/docs">Docs</a><a href="/pricing">Pricing</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a>
    </div></footer>
  );
}
