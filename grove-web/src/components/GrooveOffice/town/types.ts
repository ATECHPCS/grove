/** Minimal seat descriptor consumed by WorkerManager (adapted from Agent Town). */
export interface SeatState {
  seatId: string;
  label: string;
  assigned?: boolean;
  spriteKey?: string;
}
