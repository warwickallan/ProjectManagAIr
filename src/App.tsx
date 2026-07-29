import { AppFrame } from './components';
import { PortfolioPage } from './PortfolioPage';
import { ProjectPage } from './ProjectPage';
import { useRoute } from './useRoute';

export function App() {
  const route = useRoute();
  return (
    <AppFrame active={route.name}>
      {route.name === 'portfolio' ? <PortfolioPage /> : <ProjectPage projectId={route.projectId} focus={route.focus} />}
    </AppFrame>
  );
}
