// @ts-nocheck
// Registry of built-in JS emulators for TPM plugins.

import tpmSelf from './tpm-self.js';
import sensible from './sensible.js';
import resurrect from './resurrect.js';
import continuum from './continuum.js';
import yank from './yank.js';
import painControl from './pain-control.js';
import vimTmuxNavigator from './vim-tmux-navigator.js';
import dracula from './dracula.js';
import fzfUrl from './fzf-url.js';
import { prefixHighlight, tmuxBattery, onlineStatus } from './status-extras.js';

export const EMULATORS = [
  tpmSelf, sensible, resurrect, continuum, yank, painControl,
  vimTmuxNavigator, dracula, fzfUrl, prefixHighlight, tmuxBattery, onlineStatus,
];
