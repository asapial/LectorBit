import { Outlet } from 'react-router';
import { AppShell } from '../components/layout/AppShell';

export function AppLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}