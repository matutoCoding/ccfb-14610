// ============================================================
// 全局状态:从 IndexedDB 加载/保存,简单 pub/sub
// ============================================================

import type { PassPlan, PositionerConfig, RobotConfig, RobotProgram, WpsParams, Workpiece } from '../core/types';
import { listRecords, putRecord, deleteRecord, uid } from '../core/db';
import { defaultPositioner, defaultRobot, defaultWpsList } from '../core/defaults';

export interface AppState {
  workpieces: Workpiece[];
  wpsList: WpsParams[];
  plans: PassPlan[];
  programs: RobotProgram[];
  robot: RobotConfig;
  positioner: PositionerConfig;
  currentWorkpieceId: string | null;
  currentSeamId: string | null;
  currentWpsId: string | null;
  currentPlanId: string | null;
  currentProgramId: string | null;
}

type Listener = (s: AppState) => void;

const state: AppState = {
  workpieces: [],
  wpsList: [],
  plans: [],
  programs: [],
  robot: defaultRobot(),
  positioner: defaultPositioner(),
  currentWorkpieceId: null,
  currentSeamId: null,
  currentWpsId: null,
  currentPlanId: null,
  currentProgramId: null,
};

const listeners = new Set<Listener>();

export function getState(): AppState {
  return state;
}
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emit(): void {
  listeners.forEach((fn) => fn(state));
}
export function update(patch: Partial<AppState>): void {
  Object.assign(state, patch);
  emit();
}

export async function initStore(): Promise<void> {
  const [workpieces, wpsList, plans, programs] = await Promise.all([
    listRecords('workpieces'),
    listRecords('wps'),
    listRecords('plans'),
    listRecords('programs'),
  ]);
  if (wpsList.length === 0) {
    for (const w of defaultWpsList()) await putRecord('wps', w);
    state.wpsList = defaultWpsList();
  } else {
    state.wpsList = wpsList;
  }
  state.workpieces = workpieces;
  state.plans = plans;
  state.programs = programs;
  if (workpieces[0]) {
    state.currentWorkpieceId = workpieces[0].id;
    state.currentSeamId = workpieces[0].seams[0]?.id ?? null;
  }
  if (state.wpsList[0]) state.currentWpsId = state.wpsList[0].id;
  if (plans[0]) state.currentPlanId = plans[0].id;
  if (programs[0]) state.currentProgramId = programs[0].id;
  emit();
}

// ---------- 工件 ----------
export async function saveWorkpiece(wp: Workpiece): Promise<void> {
  wp.updatedAt = Date.now();
  await putRecord('workpieces', wp);
  const i = state.workpieces.findIndex((x) => x.id === wp.id);
  if (i >= 0) state.workpieces[i] = wp;
  else state.workpieces.push(wp);
  emit();
}
export async function removeWorkpiece(id: string): Promise<void> {
  await deleteRecord('workpieces', id);
  state.workpieces = state.workpieces.filter((x) => x.id !== id);
  if (state.currentWorkpieceId === id) {
    state.currentWorkpieceId = state.workpieces[0]?.id ?? null;
    state.currentSeamId = state.workpieces[0]?.seams[0]?.id ?? null;
  }
  emit();
}

// ---------- WPS ----------
export async function saveWps(wps: WpsParams): Promise<void> {
  await putRecord('wps', wps);
  const i = state.wpsList.findIndex((x) => x.id === wps.id);
  if (i >= 0) state.wpsList[i] = wps;
  else state.wpsList.push(wps);
  emit();
}
export async function removeWps(id: string): Promise<void> {
  await deleteRecord('wps', id);
  state.wpsList = state.wpsList.filter((x) => x.id !== id);
  emit();
}
export function newWps(): WpsParams {
  return { ...defaultWpsList()[0], id: uid('wps'), name: '自定义工艺' };
}

// ---------- 方案/程序 ----------
export async function savePlan(plan: PassPlan): Promise<void> {
  await putRecord('plans', plan);
  const i = state.plans.findIndex((x) => x.id === plan.id);
  if (i >= 0) state.plans[i] = plan;
  else state.plans.push(plan);
  state.currentPlanId = plan.id;
  emit();
}
export async function removePlan(id: string): Promise<void> {
  await deleteRecord('plans', id);
  state.plans = state.plans.filter((x) => x.id !== id);
  emit();
}
export async function saveProgram(prog: RobotProgram): Promise<void> {
  await putRecord('programs', prog);
  const i = state.programs.findIndex((x) => x.id === prog.id);
  if (i >= 0) state.programs[i] = prog;
  else state.programs.push(prog);
  state.currentProgramId = prog.id;
  emit();
}
export async function removeProgram(id: string): Promise<void> {
  await deleteRecord('programs', id);
  state.programs = state.programs.filter((x) => x.id !== id);
  emit();
}

// ---------- 选择器 ----------
export function currentWorkpiece(): Workpiece | undefined {
  return state.workpieces.find((w) => w.id === state.currentWorkpieceId);
}
export function currentSeam() {
  const wp = currentWorkpiece();
  return wp?.seams.find((s) => s.id === state.currentSeamId) ?? wp?.seams[0];
}
export function currentWps(): WpsParams | undefined {
  return state.wpsList.find((w) => w.id === state.currentWpsId) ?? state.wpsList[0];
}
export function currentPlan(): PassPlan | undefined {
  return state.plans.find((p) => p.id === state.currentPlanId);
}
export function currentProgram(): RobotProgram | undefined {
  return state.programs.find((p) => p.id === state.currentProgramId);
}
