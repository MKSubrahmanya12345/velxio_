import { useState } from 'react';
import HomePage from './pages/HomePage';
import ProjectPage from './pages/ProjectPage';

export default function App() {
  const [projectId, setProjectId] = useState<string | null>(null);
  return projectId ? (
    <ProjectPage projectId={projectId} onHome={() => setProjectId(null)} />
  ) : (
    <HomePage onOpen={(id) => setProjectId(id)} />
  );
}
