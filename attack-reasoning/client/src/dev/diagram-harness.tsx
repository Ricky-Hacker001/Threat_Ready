// Dev-only harness: renders the real ArchitectureDiagram with a fixture, no sign-in, for visual checks.
// Open /ar/dev-diagram.html?fixture=dense|fan|realistic&theme=dark|light
import { createRoot } from 'react-dom/client';
import '../platform.css';
import '../app.css';
import { ArchitectureDiagram } from '../reasoning/Diagram';
import { dense, fan, realistic } from './diagram-fixtures';

const q = new URLSearchParams(location.search);
const fixtures = { dense, fan, realistic } as const;
const key = (q.get('fixture') ?? 'dense') as keyof typeof fixtures;
document.documentElement.dataset.theme = q.get('theme') ?? 'dark';
createRoot(document.getElementById('root')!).render(
  <main className="tr-main" style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
    <h2 className="tr-h2" style={{ marginBottom: 12 }}>fixture: {key}</h2>
    <ArchitectureDiagram diagram={fixtures[key]} />
  </main>,
);
