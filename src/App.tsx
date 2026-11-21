import { Link, useLocation } from './lib/router';
import { AdminStatusPage } from './pages/AdminStatus';
import { Explorer } from './pages/Explorer';
import { Methodology } from './pages/Methodology';

export function PageHeader({ children }: { children?: React.ReactNode }) {
  const { pathname } = useLocation();
  const nav = (href: string, label: string) => (
    <Link href={href} aria-current={pathname === href ? 'page' : undefined} className={`hover:text-ink ${pathname === href ? 'text-ink underline underline-offset-4' : 'text-ink-soft'}`}>
      {label}
    </Link>
  );
  return (
    <header className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2 px-5 pt-4 md:px-8">
      <div className="flex items-baseline gap-3">
        <h1 className="m-0 text-[1.6rem] font-medium leading-none tracking-[-0.02em]">
          <Link href="/">Project Theia</Link>
        </h1>
        <p className="m-0 hidden text-[0.95rem] text-ink-soft sm:block">What the monitored press is reporting</p>
      </div>
      <nav aria-label="Pages" className="flex items-baseline gap-5 text-[0.95rem]">
        {children}
        {nav('/', 'Explorer')}
        {nav('/methodology', 'Methodology')}
        {nav('/admin/status', 'Status')}
      </nav>
    </header>
  );
}

export function App() {
  const { pathname } = useLocation();
  if (pathname === '/methodology') return <Methodology />;
  if (pathname === '/admin/status') return <AdminStatusPage />;
  return <Explorer />;
}
