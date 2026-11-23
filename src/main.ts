import './app/styles.css';
import { el, clear } from './app/ui';
import { initStore, getState, subscribe } from './app/store';
import { WorkpiecePage } from './app/pages/WorkpiecePage';
import { PlanningPage } from './app/pages/PlanningPage';
import { TorchPage } from './app/pages/TorchPage';
import { SimulationPage } from './app/pages/SimulationPage';
import { FormingPage } from './app/pages/FormingPage';
import { WpsCardPage } from './app/pages/WpsCardPage';

type PageId = 'workpiece' | 'planning' | 'torch' | 'sim' | 'forming' | 'card';

const NAV: { id: PageId; label: string }[] = [
  { id: 'workpiece', label: '工件库' },
  { id: 'planning', label: '坡口排道' },
  { id: 'torch', label: '焊枪姿态' },
  { id: 'sim', label: '离线仿真' },
  { id: 'forming', label: '焊道成形' },
  { id: 'card', label: '工艺卡' },
];

const pageHost = el('main', {}) as HTMLElement;
const navBtns: Record<string, HTMLButtonElement> = {};
let current: PageId = 'workpiece';
let activePage: { dispose?: () => void } | null = null;

function renderPage(id: PageId): void {
  current = id;
  Object.entries(navBtns).forEach(([k, b]) => b.classList.toggle('active', k === id));
  activePage?.dispose?.();
  clear(pageHost);
  const s = getState();
  switch (id) {
    case 'workpiece':
      activePage = new WorkpiecePage(pageHost) as unknown as { dispose?: () => void };
      break;
    case 'planning':
      activePage = new PlanningPage(pageHost) as unknown as { dispose?: () => void };
      break;
    case 'torch':
      activePage = new TorchPage(pageHost) as unknown as { dispose?: () => void };
      break;
    case 'sim':
      activePage = new SimulationPage(pageHost) as unknown as { dispose?: () => void };
      break;
    case 'forming':
      activePage = new FormingPage(pageHost) as unknown as { dispose?: () => void };
      break;
    case 'card':
      activePage = new WpsCardPage(pageHost) as unknown as { dispose?: () => void };
      break;
  }
  void s;
}

function buildShell(): void {
  const app = document.getElementById('app')!;
  const bar = el('div', { class: 'topbar' }, [
    el('div', { class: 'logo', html: '厚板焊接 <i>OLP</i> 离线编程系统' }),
    ...NAV.map((n) => {
      const b = el('button', { class: 'navbtn', text: n.label, onclick: () => renderPage(n.id) }) as HTMLButtonElement;
      navBtns[n.id] = b;
      return b;
    }),
    el('div', { class: 'spacer' }),
    el('div', { class: 'stat', id: 'db-stat' }),
  ]);
  app.append(bar, pageHost);
  subscribe((s) => {
    const stat = document.getElementById('db-stat');
    if (stat) {
      stat.innerHTML = `工件 <b>${s.workpieces.length}</b> · 方案 <b>${s.plans.length}</b> · 程序 <b>${s.programs.length}</b>`;
    }
  });
}

async function main(): Promise<void> {
  buildShell();
  await initStore();
  renderPage(current);
}

main().catch((e) => {
  console.error(e);
  pageHost.append(el('div', { class: 'panel', text: '初始化失败:' + String(e) }));
});
