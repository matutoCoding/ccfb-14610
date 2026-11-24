import type { PlanScheme, WeldSeam, Workpiece, WpsParams } from '../core/types';
import { defaultThermal, defaultWpsSets } from '../core/wps';
import { repo } from '../core/db';

export interface AppState {
  workpieces: Workpiece[];
  currentWpId: string | null;
  currentSeamId: string | null;
  wpsList: WpsParams[];
  schemes: PlanScheme[];
  currentSchemeId: string | null;
}

type Listener = () => void;

class Store {
  state: AppState = {
    workpieces: [],
    currentWpId: null,
    currentSeamId: null,
    wpsList: [],
    schemes: [],
    currentSchemeId: null,
  };
  private listeners = new Set<Listener>();

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(): void { this.listeners.forEach((l) => l()); }

  async init(): Promise<void> {
    const [wps, wpsAll, schemes] = await Promise.all([
      repo.all<Workpiece>('workpieces'),
      repo.all<WpsParams>('wps'),
      repo.all<PlanScheme>('schemes'),
    ]);
    if (!wpsAll.length) {
      for (const w of defaultWpsSets()) await repo.put('wps', w);
    }
    this.state.wpsList = wpsAll.length ? wpsAll : defaultWpsSets();
    this.state.workpieces = wps;
    this.state.schemes = schemes;
    if (wps[0]) this.state.currentWpId = wps[0].id;
    this.emit();
  }

  currentWorkpiece(): Workpiece | undefined {
    return this.state.workpieces.find((w) => w.id === this.state.currentWpId);
  }
  currentSeam(): WeldSeam | undefined {
    return this.currentWorkpiece()?.seams.find((s) => s.id === this.state.currentSeamId);
  }
  currentScheme(): PlanScheme | undefined {
    return this.state.schemes.find((s) => s.id === this.state.currentSchemeId);
  }
  wpsByRole(): { root: WpsParams; fill: WpsParams; cap: WpsParams } {
    const list = this.state.wpsList;
    const pick = (role: WpsParams['role']): WpsParams =>
      list.find((w) => w.role === role) ?? list[0];
    return { root: pick('root'), fill: pick('fill'), cap: pick('cap') };
  }

  async addWorkpiece(wp: Workpiece): Promise<void> {
    await repo.put('workpieces', wp);
    this.state.workpieces = await repo.all('workpieces');
    this.state.currentWpId = wp.id;
    this.state.currentSeamId = wp.seams[0]?.id ?? null;
    this.emit();
  }
  async updateWorkpiece(wp: Workpiece): Promise<void> {
    await repo.put('workpieces', wp);
    this.state.workpieces = await repo.all('workpieces');
    this.emit();
  }
  async deleteWorkpiece(id: string): Promise<void> {
    await repo.delete('workpieces', id);
    this.state.workpieces = await repo.all('workpieces');
    if (this.state.currentWpId === id) {
      this.state.currentWpId = this.state.workpieces[0]?.id ?? null;
      this.state.currentSeamId = null;
    }
    this.emit();
  }
  selectSeam(seamId: string): void {
    this.state.currentSeamId = seamId;
    this.state.currentSchemeId = null;
    this.emit();
  }
  async saveScheme(scheme: PlanScheme): Promise<void> {
    await repo.put('schemes', scheme);
    this.state.schemes = await repo.all('schemes');
    this.state.currentSchemeId = scheme.id;
    this.emit();
  }
  async deleteScheme(id: string): Promise<void> {
    await repo.delete('schemes', id);
    this.state.schemes = await repo.all('schemes');
    if (this.state.currentSchemeId === id) this.state.currentSchemeId = null;
    this.emit();
  }
  async saveWps(w: WpsParams): Promise<void> {
    await repo.put('wps', w);
    this.state.wpsList = await repo.all('wps');
    this.emit();
  }
}

export const store = new Store();
export { defaultThermal };
