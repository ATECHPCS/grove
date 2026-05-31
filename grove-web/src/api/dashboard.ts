import { apiClient } from "./client";

export type ProjectDisplayStatus = "active" | "idle" | "empty";
export type AgentDisplayState = "active" | "idle" | "unknown";

export interface DashboardAgent {
  id: string;
  agent: string;
  label: string;
  state: AgentDisplayState;
  session_uptime_secs: number;
  tokens_total: number;
  last_activity_at?: number;
}

export interface DashboardProject {
  id: string;
  name: string;
  project_type: string;
  status: ProjectDisplayStatus;
  tokens_total: number;
  agents: DashboardAgent[];
}

export interface DashboardActivity {
  id: string;
  project_id: string;
  agent: string;
  label: string;
  occurred_at: number;
  ambient: boolean;
}

export interface DashboardTotals {
  total_projects: number;
  active_sessions: number;
  total_sessions: number;
  tokens_total: number;
  tokens_in: number;
  tokens_out: number;
}

export interface DashboardSnapshot {
  generated_at: number;
  totals: DashboardTotals;
  projects: DashboardProject[];
  activity: DashboardActivity[];
}

/** Privacy-safe overview snapshot (5s-cached on the server). */
export async function fetchDashboard(signal?: AbortSignal): Promise<DashboardSnapshot> {
  return apiClient.get<DashboardSnapshot>("/api/v1/dashboard", signal);
}
