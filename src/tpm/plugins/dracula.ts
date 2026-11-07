// @ts-nocheck
// dracula/tmux theme: re-implements scripts/dracula.sh status-line generation.
// Status-bar widgets that were shell scripts are provided as #{dracula_*}
// format variables backed by browser APIs (wttr.in, getBattery, navigator).

const C = {
  white: '#f8f8f2', gray: '#44475a', dark_gray: '#282a36', light_purple: '#bd93f9',
  dark_purple: '#6272a4', cyan: '#8be9fd', green: '#50fa7b', orange: '#ffb86c',
  red: '#ff5555', pink: '#ff79c6', yellow: '#f1fa8c',
};

// Default "<bg> <fg>" colours per widget, from dracula.sh.
const WIDGET_COLOURS = {
  battery: 'pink dark_gray', network: 'cyan dark_gray', 'network-bandwidth': 'cyan dark_gray',
  'network-ping': 'cyan dark_gray', weather: 'orange dark_gray', time: 'dark_purple white',
  'cpu-usage': 'orange dark_gray', 'ram-usage': 'cyan dark_gray', git: 'green dark_gray',
  'attached-clients': 'cyan dark_gray', 'custom:': 'cyan dark_gray', synchronize: 'cyan dark_gray',
  ssh: 'green dark_gray', 'spotify-tui': 'green dark_gray', kubernetes: 'cyan dark_gray',
  uptime: 'cyan dark_gray', fossil: 'green dark_gray', mpc: 'green dark_gray', tmux_ram_usage: 'green dark_gray',
};

const state = { weather: '', weatherAt: 0 };

async function fetchWeather(api) {
  const fixed = api.option('@dracula-fixed-location', '');
  const fahrenheit = api.option('@dracula-show-fahrenheit', 'true') === 'true';
  const showLocation = api.option('@dracula-show-location', 'true') === 'true';
  const loc = fixed ? encodeURIComponent(fixed) : '';
  try {
    // wttr.in serves HTML to browser user agents for text formats; JSON (j1) works everywhere.
    const res = await api.fetch(`https://wttr.in/${loc}?format=j1`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cur = (await res.json()).current_condition[0];
    const desc = (cur.weatherDesc?.[0]?.value || '').trim();
    const temp = fahrenheit ? `${cur.temp_F}°F` : `${cur.temp_C}°C`;
    let text = `${desc} ${temp}`.trim();
    if (showLocation && fixed) text += ` ${fixed}`;
    state.weather = text;
  } catch {
    state.weather = state.weather || 'Weather Unavailable';
  }
  state.weatherAt = Date.now();
  api.refresh();
}

export default {
  repo: 'dracula/tmux',
  description: 'Dracula theme: colours, powerline separators, left icon, window flags and status widgets.',
  optionPrefixes: ['@dracula'],
  apply(t, api) {
    const opt = (name, def) => api.option(`@dracula-${name}`, def);
    const bool = (name, def) => opt(name, def) === 'true';
    const col = (name) => C[name] || name;

    const powerline = bool('show-powerline', 'false');
    const showFlags = bool('show-flags', 'false');
    const leftIconOpt = opt('show-left-icon', 'smiley');
    const leftPadding = Number(opt('left-icon-padding', '1'));
    const leftSep = opt('show-left-sep', '');
    const rightSep = opt('show-right-sep', '');
    const winSep = opt('inverse-divider', '');
    const plugins = opt('plugins', 'battery network weather').split(/\s+/).filter(Boolean);
    const borderContrast = bool('border-contrast', 'false');
    const military = bool('military-time', 'false');
    const showTimezone = bool('show-timezone', 'true');
    const dayMonth = bool('day-month', 'false');
    const refresh = Number(opt('refresh-rate', '5')) || 5;

    const icons = { smiley: '☺', session: '#S', window: '#W', hostname: '#H', shortname: '#h' };
    const leftIcon = (icons[leftIconOpt] ?? leftIconOpt) + ' '.repeat(Math.max(0, leftPadding));

    api.set('status-interval', String(refresh));
    api.set('status-left-length', '100');
    api.set('status-right-length', '100');
    api.set('pane-active-border-style', `fg=${borderContrast ? C.light_purple : C.dark_purple}`);
    api.set('pane-border-style', `fg=${C.gray}`);
    api.set('message-style', `bg=${C.gray},fg=${C.white}`);
    api.set('message-command-style', `bg=${C.gray},fg=${C.white}`);
    api.set('mode-style', `bg=${C.dark_purple},fg=${C.white}`);
    api.set('status-style', `bg=${C.gray},fg=${C.white}`);
    api.set('display-panes-active-colour', C.green);
    api.set('display-panes-colour', C.dark_purple);
    api.set('clock-mode-colour', C.light_purple);

    const prefixBg = `#{?client_prefix,#[bg=${C.yellow}],}`;
    const prefixFg = `#{?client_prefix,#[fg=${C.yellow}],}`;
    if (powerline) {
      api.set('status-left', `#[bg=${C.green},fg=${C.dark_gray}]${prefixBg} ${leftIcon}#[fg=${C.green},bg=${C.gray}]${prefixFg}${leftSep}`);
    } else {
      api.set('status-left', `#[bg=${C.green},fg=${C.dark_gray}]${prefixBg} ${leftIcon}`);
    }

    // Widgets.
    let right = '';
    let powerBg = C.gray;
    const unsupported = [];
    for (const name of plugins) {
      const key = name.startsWith('custom:') ? 'custom:' : name;
      const [bg, fg] = opt(`${name}-colors`, WIDGET_COLOURS[key] || 'cyan dark_gray').split(/\s+/).map(col);
      let script;
      switch (name) {
        case 'time': {
          const fmt = opt('time-format', '') || (dayMonth ? '%d/%m' : '%a %m/%d') + (military ? ' %R' : ' %I:%M %p');
          script = fmt + (showTimezone && !opt('time-format', '') ? ' %Z' : '');
          break;
        }
        case 'weather':
          script = '#{dracula_weather}';
          break;
        case 'battery':
          script = `${opt('battery-label', '♥')} #{dracula_battery}`;
          break;
        case 'network':
          script = '#{dracula_network}';
          break;
        case 'attached-clients':
          script = '1 clients';
          break;
        case 'synchronize':
          script = '';
          break;
        default:
          unsupported.push(name);
          continue;
      }
      if (powerline) {
        right += `#[fg=${bg},bg=${powerBg},nobold,nounderscore,noitalics]${rightSep}#[fg=${fg},bg=${bg}] ${script} `;
        powerBg = bg;
      } else {
        right += `#[fg=${fg},bg=${bg}] ${script} `;
      }
    }
    if (unsupported.length) api.notice(`widgets need a shell and are hidden: ${unsupported.join(', ')}`);
    api.set('status-right', right);

    const flags = showFlags ? `#{?window_flags,#[fg=${C.dark_purple}]#{window_flags},}` : '';
    const currentFlags = showFlags ? `#{?window_flags,#[fg=${C.light_purple}]#{window_flags},}` : '';
    if (powerline) {
      api.set('window-status-current-format', `#[fg=${C.gray},bg=${C.dark_purple}]${winSep}#[fg=${C.white},bg=${C.dark_purple}] #I #W${currentFlags} #[fg=${C.dark_purple},bg=${C.gray}]${leftSep}`);
    } else {
      api.set('window-status-current-format', `#[fg=${C.white},bg=${C.dark_purple}] #I #W${currentFlags} `);
    }
    api.set('window-status-format', `#[fg=${C.white}]#[bg=${C.gray}] #I #W${flags}`);
    api.set('window-status-separator', '');
    api.set('window-status-style', 'default');
    api.set('window-status-current-style', 'default');
    api.set('@ctmux-background', C.dark_gray);
    api.set('@ctmux-foreground', C.white);

    // Widget data sources.
    api.formatVar('dracula_weather', () => {
      if (!state.weatherAt) { state.weatherAt = 1; fetchWeather(api); }
      return state.weather || 'Loading weather...';
    });
    if (plugins.includes('weather')) api.every(20 * 60 * 1000, () => fetchWeather(api));

    api.formatVar('dracula_network', () => (typeof navigator !== 'undefined' && navigator.onLine === false
      ? 'Offline'
      : (navigator.connection?.effectiveType ? `Online ${navigator.connection.effectiveType}` : 'Online')));

    let batt = null;
    if (plugins.includes('battery') && typeof navigator !== 'undefined' && navigator.getBattery) {
      navigator.getBattery().then((b) => {
        batt = b;
        b.addEventListener('levelchange', api.refresh);
        b.addEventListener('chargingchange', api.refresh);
        api.refresh();
      }).catch(() => {});
    }
    api.formatVar('dracula_battery', () => {
      if (!batt) return 'AC';
      const pct = Math.round(batt.level * 100);
      return batt.charging ? `AC ${pct}%` : `${pct}%`;
    });
  },
};
