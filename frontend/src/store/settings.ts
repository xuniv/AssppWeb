import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type ThemeType = 'light' | 'dark' | 'system';
export type StoreRuntimeMode = 'client' | 'server';

interface SettingsState {
  defaultCountry: string;
  defaultEntity: 'iPhone' | 'iPad';
  theme: ThemeType;
  storeRuntimeMode: StoreRuntimeMode;
  setDefaultCountry: (country: string) => void;
  setDefaultEntity: (entity: 'iPhone' | 'iPad') => void;
  setTheme: (theme: ThemeType) => void;
  setStoreRuntimeMode: (mode: StoreRuntimeMode) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      defaultCountry: 'US',
      defaultEntity: 'iPhone',
      theme: 'light',
      storeRuntimeMode: 'client',
      setDefaultCountry: (country) => set({ defaultCountry: country }),
      setDefaultEntity: (entity) => set({ defaultEntity: entity }),
      setTheme: (theme) => set({ theme }),
      setStoreRuntimeMode: (mode) => set({ storeRuntimeMode: mode }),
    }),
    {
      name: 'asspp-settings',
    },
  ),
);
