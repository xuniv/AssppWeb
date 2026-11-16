import { create } from 'zustand';

export const useRuntimeStore = create<{ stage: string; setStage: (stage: string) => void }>((set) => ({
  stage: '',
  setStage: (stage) => set({ stage: stage === 'preparing' || stage === 'running' ? stage : '' }),
}));
