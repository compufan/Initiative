import { useEffect } from 'react';
import { BrowserRouter, NavLink, Navigate, useNavigate, useRoutes } from 'react-router-dom';
import { ToastHost } from './components/Feedback.js';
import { AuthScreen } from './screens/AuthScreen.js';
import { SplashScreen } from './screens/SplashScreen.js';
import { UpdateBanner } from './screens/UpdateBanner.js';
import { initModules, moduleNavItems, moduleRoutes } from './modules/registry.js';
import { appModules } from './modules/registry.js';
import { connectChatRealtime, useChat } from './state/chat.js';
import { useSession } from './state/session.js';
import { useNavVisibility } from './state/ui.js';

function BottomNav() {
  const items = moduleNavItems();
  const hidden = useNavVisibility((state) => state.hidden > 0);
  if (hidden || items.length === 0) return null;
  return (
    <nav className="app-nav">
      {items.map((item) => (
        <NavItemLink
          key={item.path}
          path={item.path}
          label={item.label}
          icon={item.icon}
          useBadge={item.useBadge}
        />
      ))}
    </nav>
  );
}

function NavItemLink({
  path,
  label,
  icon,
  useBadge,
}: {
  path: string;
  label: string;
  icon: string;
  useBadge?: () => number;
}) {
  const badge = useBadge?.() ?? 0;
  return (
    <NavLink to={path} className={({ isActive }) => (isActive ? 'active' : undefined)}>
      <span className="nav-icon" aria-hidden="true">
        {icon}
      </span>
      <span>{label}</span>
      {badge > 0 && <span className="nav-badge">{badge > 99 ? '99+' : badge}</span>}
    </NavLink>
  );
}

function ModuleOverlays() {
  return (
    <>{appModules.map((module) => (module.overlay ? <module.overlay key={module.key} /> : null))}</>
  );
}

function AppRoutes() {
  return useRoutes([
    { path: '/', element: <Navigate to="/chats" replace /> },
    ...moduleRoutes(),
    { path: '*', element: <Navigate to="/chats" replace /> },
  ]);
}

/** Lets the service worker (notification click) drive in-app navigation. */
function ServiceWorkerBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | undefined;
      if (data?.type === 'navigate' && data.url) navigate(data.url);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate]);
  return null;
}

function AuthedApp() {
  useEffect(() => {
    connectChatRealtime();
    void useChat.getState().hydrate();
    const teardown = initModules();
    return teardown;
  }, []);

  return (
    <div className="app-shell">
      <ServiceWorkerBridge />
      <UpdateBanner />
      <AppRoutes />
      <BottomNav />
      <ModuleOverlays />
      <ToastHost />
    </div>
  );
}

export function App() {
  const status = useSession((state) => state.status);

  useEffect(() => {
    void useSession.getState().bootstrap();
  }, []);

  return (
    <BrowserRouter>
      {status === 'loading' ? (
        <SplashScreen />
      ) : status === 'anonymous' ? (
        <>
          <AuthScreen />
          <ToastHost />
        </>
      ) : (
        <AuthedApp />
      )}
    </BrowserRouter>
  );
}
