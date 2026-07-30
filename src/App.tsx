import type { Route } from './useRoute';
import { AppFrame } from './components';
import { PortfolioPage } from './PortfolioPage';
import { SettingsPage } from './SettingsPage';
import { ProjectPage } from './ProjectPage';
import { TodayPage } from './WorkdayPage';
import { InboxPage } from './InboxPage';
import { AIChatPage } from './AIChatPage';
import { useRoute } from './useRoute';

export function App() {
  const route = useRoute();
  return (
    <AppFrame active={navActive(route)}>
      {route.name === 'today' ? <TodayPage mode="day" /> : null}
      {route.name === 'calendar' ? <TodayPage mode="week" /> : null}
      {route.name === 'inbox' ? <InboxPage /> : null}
      {route.name === 'portfolio' || route.name === 'needs-you' ? <PortfolioPage initialSection={route.name === 'needs-you' ? 'attention' : undefined} /> : null}
      {route.name === 'settings' ? <SettingsPage /> : null}
      {route.name === 'project' ? <ProjectPage projectId={route.projectId} tab={route.tab} /> : null}
      {route.name === 'ai-chat' ? <AIChatPage /> : null}
    </AppFrame>
  );
}

function navActive(route: Route) {
  if (route.name === 'project') return 'portfolio';
  return route.name;
}
