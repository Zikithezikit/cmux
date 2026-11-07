// Small status-line plugins that only provide #{format} variables.

import type { PluginEmulator } from '../tpm.js';

/** Battery Status API (not in lib.dom). */
interface BatteryManager extends EventTarget {
  level: number;
  charging: boolean;
  dischargingTime: number;
}

type BrowserNavigator = Navigator & {
  getBattery?(): Promise<BatteryManager>;
};

export const prefixHighlight = {
  repo: 'tmux-plugins/tmux-prefix-highlight',
  description: '#{prefix_highlight} shows when the prefix (or copy mode) is active.',
  optionPrefixes: ['@prefix_highlight'],
  apply(t, api) {
    api.formatVar('prefix_highlight', () => {
      const fg = api.option('@prefix_highlight_fg', 'colour231');
      const bg = api.option('@prefix_highlight_bg', 'colour04');
      const prefix = t.getOption('prefix').replace(/^C-/, '^').toUpperCase();
      if (t.clientPrefix) {
        const text = api.option('@prefix_highlight_prefix_prompt', '') || prefix;
        return `#[fg=${fg},bg=${bg}] ${text} #[default]`;
      }
      if (api.option('@prefix_highlight_show_copy_mode', 'off') === 'on' && t.server.pane?.mode) {
        const style = api.option('@prefix_highlight_copy_mode_attr', 'fg=default,bg=yellow');
        return `#[${style}] ${api.option('@prefix_highlight_copy_prompt', 'Copy')} #[default]`;
      }
      return api.option('@prefix_highlight_empty_prompt', '');
    });
  },
} satisfies PluginEmulator;

let battery: BatteryManager | null = null;
async function watchBattery(refresh: () => void) {
  if (battery || typeof navigator === 'undefined' || !(navigator as BrowserNavigator).getBattery) return;
  try {
    battery = await (navigator as BrowserNavigator).getBattery!();
    for (const ev of ['levelchange', 'chargingchange']) battery.addEventListener(ev, refresh);
    refresh();
  } catch { battery = null; }
}

export const tmuxBattery = {
  repo: 'tmux-plugins/tmux-battery',
  description: '#{battery_percentage}, #{battery_icon}, #{battery_status}, #{battery_remain} via navigator.getBattery().',
  optionPrefixes: ['@batt'],
  apply(t, api) {
    watchBattery(api.refresh);
    const pct = () => (battery ? Math.round(battery.level * 100) : null);
    api.formatVar('battery_percentage', () => (pct() == null ? '' : `${pct()}%`));
    api.formatVar('battery_status', () => (battery ? (battery.charging ? 'charging' : 'discharging') : ''));
    api.formatVar('battery_icon', () => {
      if (!battery) return '';
      if (battery.charging) return api.option('@batt_icon_status_charging', '⚡');
      const p = pct()!;
      if (p >= 95) return api.option('@batt_icon_charge_tier8', '█');
      if (p >= 65) return api.option('@batt_icon_charge_tier6', '▆');
      if (p >= 35) return api.option('@batt_icon_charge_tier4', '▄');
      return api.option('@batt_icon_charge_tier1', '▁');
    });
    api.formatVar('battery_remain', () => {
      if (!battery || battery.charging || !Number.isFinite(battery.dischargingTime)) return '';
      const m = Math.round(battery.dischargingTime / 60);
      return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
    });
  },
} satisfies PluginEmulator;

export const onlineStatus = {
  repo: 'tmux-plugins/tmux-online-status',
  description: '#{online_status} from navigator.onLine.',
  optionPrefixes: ['@online_icon', '@offline_icon'],
  apply(t, api) {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', api.refresh);
      window.addEventListener('offline', api.refresh);
    }
    api.formatVar('online_status', () => (typeof navigator !== 'undefined' && navigator.onLine === false
      ? api.option('@offline_icon', 'offline')
      : api.option('@online_icon', 'online')));
  },
} satisfies PluginEmulator;
