import './styles.css';
import { h } from './ui/dom';
import { store } from './ui/store';
import { createWorkpiece } from './core/workpieces';
import { renderWorkpiecePage } from './ui/page-workpiece';
import { renderPlanningPage } from './ui/page-planning';
import { renderTorchPage } from './ui/page-torch';
import { renderSimulationPage } from './ui/page-simulation';
import { renderFormingPage } from './ui/page-forming';
import { renderProcessCardPage } from './ui/page-card';

type RouteId = 'workpiece' | 'planning' | 'torch' | 'simulation' | 'forming' | 'card';

const NAV: Array<{ id: RouteId; icon: string; label: string; en: string }> = [
  { id: 'workpiece', icon: '🏭', label: '工件库', en: 'Workpiece' },
  { id: 'planning', icon: '📐', label: '坡口排道', en: 'Planning' },
  { id: 'torch', icon: '🤖', label: '焊枪姿态', en: 'Torch' },
  { id: 'simulation', icon: '🎬', label: '离线仿真', en: 'Simulation' },
  { id: 'forming', icon: '🔬', label: '焊道成形', en: 'Forming' },
  { id: 'card', icon: '📋', label: '工艺卡', en: 'Process Card' },
];

const RENDERERS: Record<RouteId, (el: HTMLElement) => void> = {
  workpiece: renderWorkpiecePage,
  planning: renderPlanningPage,
  torch: renderTorchPage,
  simulation: renderSimulationPage,
  forming: renderFormingPage,
  card: renderProcessCardPage,
};

let route: RouteId = (location.hash.replace('#', '') as RouteId) || 'workpiece';
if (!NAV.some((n) => n.id === route)) route = 'workpiece';

function render(): void {
  const app = document.getElementById('app')!;
  app.innerHTML = '';
  const main = h('main', { class: 'main' }) as HTMLElement;
  app.append(
    h('header', { class: 'app-header' },
      h('h1', {}, '厚板多层多道焊接离线编程系统'),
      h('span', { class: 'sub' }, 'Multi-pass Weld Offline Programming · TypeScript + three.js · IndexedDB'),
      h('div', { class: 'spacer' }),
      h('span', { class: 'sub' }, store.currentWorkpiece()?.name ?? '未选择工件')),
    h('div', { class: 'layout' },
      h('nav', { class: 'sidebar' },
        ...NAV.map((n) =>
          h('div', {
            class: `nav-item ${route === n.id ? 'active' : ''}`,
            onclick: () => { route = n.id; location.hash = n.id; render(); },
          },
            h('span', { class: 'icon' }, n.icon),
            h('span', { class: 'label' }, n.label),
            h('span', { class: 'en' }, n.en)))),
      main,
    ),
  );
  RENDERERS[route](main);
}

window.addEventListener('hashchange', () => {
  const r = location.hash.replace('#', '') as RouteId;
  if (NAV.some((n) => n.id === r)) { route = r; render(); }
});

store.subscribe(render);
void (async (): Promise<void> => {
  await store.init();
  if (!store.state.workpieces.length) {
    await store.addWorkpiece(createWorkpiece('boom-box'));
  }
  render();
})();
