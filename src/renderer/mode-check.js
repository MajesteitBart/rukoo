// Settings > General > Tabs as main has it now (main.js modeShown): whether a mode shows. A control of the desktop app
// asks it after its last await and before it writes, opens or inserts something of that mode, which may have been
// turned off meanwhile in any window. The window's own copy of the setting follows main a moment later.
import { api } from './ui.js';

export const modeShownNow = (mode) => api('modeShown', mode).then((on) => on !== false, () => true);
